import type { RawJSONLines } from '../types';
import { readClaudeControlCommandRowShape } from '../utils/controlCommandRows';
import { parseRawJsonLinesObject } from '../utils/parseRawJsonLines';

/**
 * Claude local-command transcript marker bookkeeping (incident 2026-06-11, L3).
 *
 * Claude writes JSONL user rows for TUI local commands (`<command-name>…</command-name>`
 * + `<command-args>…`) and their output (`<local-command-stdout>…`). Visibility is owned
 * globally by `isClaudeInternalTranscriptMessage`; all such rows are internal and never render
 * as chat bubbles.
 *
 * This helper owns only the consumed-marker side effect. Rows observed on the raw transcript
 * channel are reported through `onConsumed` so the launcher can persist
 * `recordClaudeJsonlMessageConsumed`; without that marker, scanner-level filtering happens before
 * processed-key registration and the same internal row can be re-observed on relaunch.
 */
export type ClaudeUnifiedControlCommandEchoBookkeeper = Readonly<{
  /** Compatibility hook for the TUI controller; registration no longer gates visibility. */
  recordTypedControlCommand(commandText: string): void;
  /** Marks a raw transcript value as consumed when it is a Claude local-command row. */
  markConsumedTranscriptMessage(value: unknown): boolean;
}>;

export function createClaudeUnifiedControlCommandEchoBookkeeper(opts: Readonly<{
  onConsumed?: ((message: RawJSONLines) => void) | undefined;
}> = {}): ClaudeUnifiedControlCommandEchoBookkeeper {
  return {
    recordTypedControlCommand() {},

    markConsumedTranscriptMessage(value) {
      const message = parseRawJsonLinesObject(value);
      if (!message) return false;
      const shape = readClaudeControlCommandRowShape(message);
      if (!shape) return false;
      opts.onConsumed?.(message);
      return true;
    },
  };
}
