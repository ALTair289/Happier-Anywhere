import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity';
import { readPendingLocalId } from '@happier-dev/protocol';

export type ClaudeUnifiedAcceptedPromptDeliveryIdentityLike = Readonly<{
  localIds?: readonly string[] | null | undefined;
  userMessageSeq?: number | null | undefined;
  userMessageSeqs?: readonly number[] | null | undefined;
}>;

export type ClaudeUnifiedPromptBatchDeliveryLike = Readonly<{
  message: string;
  maxUserMessageSeq?: number | null | undefined;
  userMessageLocalIds?: readonly string[] | null | undefined;
}>;

function readValidSeqs(value: ClaudeUnifiedAcceptedPromptDeliveryIdentityLike | null | undefined): Set<number> {
  const seqs = new Set<number>();
  const userMessageSeq = value?.userMessageSeq;
  if (typeof userMessageSeq === 'number' && Number.isInteger(userMessageSeq) && userMessageSeq >= 0) {
    seqs.add(userMessageSeq);
  }
  for (const seq of value?.userMessageSeqs ?? []) {
    if (Number.isInteger(seq) && seq >= 0) {
      seqs.add(seq);
    }
  }
  return seqs;
}

function readValidLocalIds(value: ClaudeUnifiedAcceptedPromptDeliveryIdentityLike | null | undefined): Set<string> {
  const localIds = new Set<string>();
  for (const localId of value?.localIds ?? []) {
    const parsedLocalId = readPendingLocalId(localId);
    if (parsedLocalId !== null) localIds.add(parsedLocalId);
  }
  return localIds;
}

export function doesClaudeUnifiedPromptBatchMatchAcceptedTranscript(params: Readonly<{
  batch: ClaudeUnifiedPromptBatchDeliveryLike;
  match: Readonly<{
    deliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentityLike | null;
    acceptedPromptNormalizedText: string;
  }>;
}>): boolean {
  const seqs = readValidSeqs(params.match.deliveryIdentity);
  const localIds = readValidLocalIds(params.match.deliveryIdentity);
  const hasDeliveryIdentity = seqs.size > 0 || localIds.size > 0;

  if (hasDeliveryIdentity) {
    const batchSeq = params.batch.maxUserMessageSeq;
    if (typeof batchSeq === 'number' && seqs.has(batchSeq)) return true;
    return (params.batch.userMessageLocalIds ?? []).some((localId) => (
      readPendingLocalId(localId) !== null && localIds.has(localId)
    ));
  }

  const normalizedBatchText = normalizeClaudeUnifiedPromptIdentityText(params.batch.message);
  return normalizedBatchText.length > 0
    && normalizedBatchText === params.match.acceptedPromptNormalizedText;
}
