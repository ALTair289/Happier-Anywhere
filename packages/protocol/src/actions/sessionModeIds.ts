type SessionModeOptionLike =
  | Readonly<{ id: string }>
  | Readonly<{ value: string }>;

function readNonBlankModeId(raw: unknown): string {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : '';
}

function readOptionModeId(option: SessionModeOptionLike): string {
  if ('id' in option) return readNonBlankModeId(option.id);
  return readNonBlankModeId(option.value);
}

export function resolveRequestedSessionModeId(
  requestedModeId: string,
  options: readonly SessionModeOptionLike[] | null | undefined,
): string {
  const normalizedRequestedModeId = readNonBlankModeId(requestedModeId);
  if (normalizedRequestedModeId !== 'default') return normalizedRequestedModeId;
  return Array.isArray(options) && options.some((option) => readOptionModeId(option) === 'default')
    ? 'default'
    : '';
}
