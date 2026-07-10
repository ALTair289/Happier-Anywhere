import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';

export function normalizeInitialTranscriptAfterSeq(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isInteger(value)) return undefined;
  if (value < 0) return undefined;
  return value;
}

export function applyInitialTranscriptAfterSeqToAttachPayload(
  payload: SessionAttachFilePayload,
  initialTranscriptAfterSeq: unknown,
  opts?: Readonly<{
    /**
     * Owed-delivery watermark (A-F2): clamps the explicit wake cursor so user rows committed but
     * never delivered to the runner are redelivered instead of skipped forever.
     */
    deliveredUserMessageSeq?: number | null;
  }>,
): SessionAttachFilePayload {
  const normalizedInitialTranscriptAfterSeq = normalizeInitialTranscriptAfterSeq(initialTranscriptAfterSeq);
  if (normalizedInitialTranscriptAfterSeq === undefined) {
    return payload;
  }

  const deliveredFloor = normalizeInitialTranscriptAfterSeq(opts?.deliveredUserMessageSeq ?? undefined);
  const effectiveCursor =
    deliveredFloor === undefined
      ? normalizedInitialTranscriptAfterSeq
      : Math.min(normalizedInitialTranscriptAfterSeq, deliveredFloor);

  return {
    ...payload,
    lastObservedMessageSeq: effectiveCursor,
    initialTranscriptAfterSeq: effectiveCursor,
    initialTranscriptCatchUpAuthorization: 'explicit_cursor',
  };
}
