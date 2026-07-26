import type { AcpToolCallSnapshot } from './types';

/**
 * Applies ACP ToolCallUpdate semantics: every present field replaces that field, omitted fields
 * retain their previous value, null clears nullable fields, and empty collections replace rather
 * than append. Raw input/output are opaque values and are never guessed or recursively merged.
 */
export function mergeToolCallSnapshot(
  previous: AcpToolCallSnapshot | null,
  patch: AcpToolCallSnapshot,
): AcpToolCallSnapshot {
  if (previous && previous.toolCallId !== patch.toolCallId) {
    throw new Error('Cannot merge ACP tool-call patches with different toolCallId values');
  }

  const merged: Record<string, unknown> = previous ? { ...previous } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.toolCallId = patch.toolCallId;
  return merged as AcpToolCallSnapshot;
}
