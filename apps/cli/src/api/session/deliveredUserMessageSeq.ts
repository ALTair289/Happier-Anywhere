import type { Metadata } from '@/api/types';

export type UserMessageDeliveryWatermarkModeV1 = 'queueHandoff' | 'providerAcceptance';

/**
 * Owed-delivery watermark (QA A-F2 / D15b): highest user-row seq that is no longer owed to the
 * runner. Most rows become unowed when handed to the runner's agent loop; provider-native rows
 * written from the terminal transcript become unowed when their local echo proves they already
 * reached provider custody. Resume paths previously synthesized the catch-up cursor from
 * `session.seq`, so user rows committed while the runner was down were never delivered on any
 * resume. The runner persists this watermark in session metadata; daemon attach paths clamp the
 * catch-up cursor to it so owed rows are redelivered (at-least-once, deduped by localId/echo
 * suppression).
 */
export function readDeliveredUserMessageSeqV1(metadata: Readonly<Record<string, unknown>> | null | undefined): number | null {
  const value = metadata?.deliveredUserMessageSeqV1;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function readProviderAcceptedUserMessageSeqV1(metadata: Readonly<Record<string, unknown>> | null | undefined): number | null {
  const value = metadata?.providerAcceptedUserMessageSeqV1;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function mergeDeliveredUserMessageSeqV1(
  metadata: Metadata,
  seq: number,
): Readonly<{ changed: boolean; metadata: Metadata }> {
  const normalized = Number.isInteger(seq) && seq >= 0 ? seq : null;
  if (normalized === null) return { changed: false, metadata };
  const existing = readDeliveredUserMessageSeqV1(metadata as unknown as Record<string, unknown>);
  if (existing !== null && existing >= normalized) return { changed: false, metadata };
  return { changed: true, metadata: { ...metadata, deliveredUserMessageSeqV1: normalized } };
}

export function mergeProviderAcceptedUserMessageSeqV1(
  metadata: Metadata,
  seq: number,
): Readonly<{ changed: boolean; metadata: Metadata }> {
  const normalized = Number.isInteger(seq) && seq >= 0 ? seq : null;
  if (normalized === null) return { changed: false, metadata };
  const existing = readProviderAcceptedUserMessageSeqV1(metadata as unknown as Record<string, unknown>);
  if (existing !== null && existing >= normalized) return { changed: false, metadata };
  return { changed: true, metadata: { ...metadata, providerAcceptedUserMessageSeqV1: normalized } };
}

export function readUserMessageDeliveryWatermarkModeV1(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): UserMessageDeliveryWatermarkModeV1 | null {
  const value = metadata?.userMessageDeliveryWatermarkModeV1;
  return value === 'queueHandoff' || value === 'providerAcceptance' ? value : null;
}

export function mergeUserMessageDeliveryWatermarkModeV1(
  metadata: Metadata,
  mode: UserMessageDeliveryWatermarkModeV1,
): Readonly<{ changed: boolean; metadata: Metadata }> {
  const existing = readUserMessageDeliveryWatermarkModeV1(metadata as unknown as Record<string, unknown>);
  if (existing === mode) return { changed: false, metadata };
  return { changed: true, metadata: { ...metadata, userMessageDeliveryWatermarkModeV1: mode } };
}

export function clampAttachCursorToDeliveredUserMessageSeq(
  cursor: number | undefined,
  deliveredUserMessageSeq: number | null,
): number | undefined {
  if (cursor === undefined || deliveredUserMessageSeq === null) return cursor;
  return Math.min(cursor, deliveredUserMessageSeq);
}

export function resolveAttachCursorForUserMessageDeliveryWatermark(params: Readonly<{
  cursor: number | undefined;
  mode: UserMessageDeliveryWatermarkModeV1;
  deliveredUserMessageSeq: number | null;
  providerAcceptedUserMessageSeq: number | null;
}>): Readonly<{ cursor: number | undefined; effectiveWatermarkSeq: number | null }> {
  if (params.cursor === undefined) {
    return { cursor: undefined, effectiveWatermarkSeq: null };
  }

  if (params.mode === 'providerAcceptance') {
    const effectiveWatermarkSeq = params.providerAcceptedUserMessageSeq ?? 0;
    return {
      cursor: Math.min(params.cursor, effectiveWatermarkSeq),
      effectiveWatermarkSeq,
    };
  }

  return {
    cursor: clampAttachCursorToDeliveredUserMessageSeq(params.cursor, params.deliveredUserMessageSeq),
    effectiveWatermarkSeq: params.deliveredUserMessageSeq,
  };
}
