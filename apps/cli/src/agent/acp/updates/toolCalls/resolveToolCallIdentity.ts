import type { AcpToolCallSnapshot } from './types';

const GENERIC_TOOL_IDENTITIES = new Set(['', 'unknown', 'other', 'tool']);

function normalizeCandidate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isGenericToolCallIdentity(value: string): boolean {
  return GENERIC_TOOL_IDENTITIES.has(value.toLowerCase());
}

export function resolveBestToolCallIdentity(params: Readonly<{
  previous: string | null | undefined;
  candidate: string | null | undefined;
}>): string {
  const previous = normalizeCandidate(params.previous);
  const candidate = normalizeCandidate(params.candidate);
  if (!previous) return candidate ?? 'unknown';
  if (!candidate) return previous;
  if (!isGenericToolCallIdentity(previous)) return previous;
  return isGenericToolCallIdentity(candidate) ? previous : candidate;
}

export function buildToolNameInferenceInput(snapshot: AcpToolCallSnapshot): Record<string, unknown> {
  const inferenceSource = snapshot.rawInput && typeof snapshot.rawInput === 'object' && !Array.isArray(snapshot.rawInput)
    ? snapshot.rawInput
    : snapshot.rawOutput && typeof snapshot.rawOutput === 'object' && !Array.isArray(snapshot.rawOutput)
      ? snapshot.rawOutput
      : null;
  const input = inferenceSource ? { ...(inferenceSource as Record<string, unknown>) } : {};
  const title = typeof snapshot.title === 'string' ? snapshot.title.trim() : '';
  if (title) {
    if (typeof input.title !== 'string' || !input.title.trim()) input.title = title;
    if (typeof input.description !== 'string' || !input.description.trim()) input.description = title;
  }
  const existingAcp = input._acp && typeof input._acp === 'object' && !Array.isArray(input._acp)
    ? input._acp as Record<string, unknown>
    : {};
  input._acp = {
    ...existingAcp,
    ...(title ? { title } : {}),
    ...(snapshot._meta ? { meta: snapshot._meta } : {}),
  };
  return input;
}
