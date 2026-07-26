/** Opaque identifiers are validated for presence without changing their bytes. */
export function readNonBlankOpaqueIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
