import type { RawJSONLines } from '../types';

/**
 * Claude TUI slash-command JSONL row shapes (incident 2026-06-11, L3 + resume-replay leak).
 *
 * When a slash command is submitted in Claude's TUI, Claude writes user rows containing
 * `<command-name>…</command-name>` / `<command-args>…` and a follow-up
 * `<local-command-stdout>…` row. These are control bookkeeping, never conversation text.
 * The shared shape parser lives here so provider echo handling and transcript visibility
 * agree on what a command row is.
 */
export type ClaudeControlCommandRowShape =
  | Readonly<{ kind: 'command'; name: string; args: string }>
  | Readonly<{ kind: 'stdout' }>;

export type ClaudeControlCommandCompletionOwner = 'local_stdout' | 'external_lifecycle';

const LOCAL_STDOUT_TERMINAL_COMMANDS = new Set([
  '/effort',
  '/model',
  '/status',
]);

/**
 * Classifies which existing lifecycle owner may terminalize a Claude local command.
 *
 * Settings/status commands are fully completed by their paired local-command stdout row.
 * Conversation-affecting commands (`/compact`, `/btw`, and unknown/future commands) remain on
 * their dedicated provider lifecycle owner; treating their acknowledgement stdout as turn
 * completion can race or double-settle real conversation/compaction work. Unknown commands are
 * deliberately fail-closed until real provider evidence establishes their semantics.
 */
export function resolveClaudeControlCommandCompletionOwner(
  commandName: string,
): ClaudeControlCommandCompletionOwner {
  return LOCAL_STDOUT_TERMINAL_COMMANDS.has(commandName.trim().toLowerCase())
    ? 'local_stdout'
    : 'external_lifecycle';
}

export const CLAUDE_CONTROL_COMMAND_TRANSCRIPT_PREFIXES = [
  '<command-name>',
  '<local-command-stdout>',
] as const;

const COMMAND_NAME_TAG = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS_TAG = /<command-args>([^<]*)<\/command-args>/;

function firstMessageText(message: RawJSONLines): string | null {
  const envelope = (message as Record<string, unknown>).message;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const content = (envelope as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const text = (item as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

export function readClaudeControlCommandRowShape(message: RawJSONLines): ClaudeControlCommandRowShape | null {
  if (message.type !== 'user') return null;
  const text = firstMessageText(message);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith(CLAUDE_CONTROL_COMMAND_TRANSCRIPT_PREFIXES[1])) return { kind: 'stdout' };
  if (!trimmed.startsWith(CLAUDE_CONTROL_COMMAND_TRANSCRIPT_PREFIXES[0])) return null;
  const nameMatch = COMMAND_NAME_TAG.exec(trimmed);
  if (!nameMatch) return null;
  return {
    kind: 'command',
    name: nameMatch[1].trim(),
    args: (COMMAND_ARGS_TAG.exec(trimmed)?.[1] ?? '').trim(),
  };
}
