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
  if (trimmed.startsWith('<local-command-stdout>')) return { kind: 'stdout' };
  if (!trimmed.startsWith('<command-name>')) return null;
  const nameMatch = COMMAND_NAME_TAG.exec(trimmed);
  if (!nameMatch) return null;
  return {
    kind: 'command',
    name: nameMatch[1].trim(),
    args: (COMMAND_ARGS_TAG.exec(trimmed)?.[1] ?? '').trim(),
  };
}
