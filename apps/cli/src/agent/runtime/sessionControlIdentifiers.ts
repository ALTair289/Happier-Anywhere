import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

/** Session-control IDs are opaque; validate without transforming. */
export function readNonBlankSessionControlIdentifier(value: unknown): string | null {
  return readNonBlankOpaqueIdentifier(value);
}

export function readSessionControlValueId(value: unknown): string | boolean | null {
  if (typeof value === 'string') return readNonBlankSessionControlIdentifier(value);
  if (typeof value === 'boolean') return value;
  // Metadata overrides retain their historical scalar union, while ACP select values are strings.
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}
