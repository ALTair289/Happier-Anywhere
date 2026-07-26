import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';

import type { ACPProvider } from '../sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from './types';
import type { StreamedTranscriptSegmentRuntime, StreamedTranscriptSegmentState } from './segmentRuntime';
import type { SessionMessageCommitResult } from '../sessionMessageCommitResult';
import {
  buildStreamedTranscriptSegmentSnapshotBody,
  buildStreamedTranscriptSegmentSnapshotMeta,
} from './buildStreamedTranscriptSegmentSnapshot';

export function commitStreamedTranscriptSegmentSnapshot(params: {
  provider: ACPProvider;
  session: StreamedTranscriptWriterSession;
  segment: StreamedTranscriptSegmentRuntime;
  state: StreamedTranscriptSegmentState;
  interruptedReason?: string;
}) {
  const { provider, session, segment, state, interruptedReason } = params;

  if (segment.isCommittingDurable) {
    segment.pendingDurableCommit = { state, interruptedReason };
    return;
  }

  segment.isCommittingDurable = true;

  const nowMs = Date.now();
  const commitVersion = segment.textVersion;
  const commitText = segment.accumulatedText;
  const commitTextLen = segment.accumulatedText.length;
  const durableLocalId = segment.segmentLocalId;
  const body = buildStreamedTranscriptSegmentSnapshotBody(segment);
  const meta = buildStreamedTranscriptSegmentSnapshotMeta({ segment, state, interruptedReason, nowMs });

  const markDurablyPersisted = (commitResult: SessionMessageCommitResult | null) => {
    segment.didWriteDurable = true;
    segment.lastDurableText = commitText;
    segment.lastCheckpointAtMs = Date.now();
    segment.lastCheckpointTextLen = commitTextLen;
    segment.appendOnlySinceLastDurableSnapshot = true;
    segment.lastCommittedTextVersion = commitVersion;
    segment.lastCommittedState = state;
    segment.lastCommitError = null;
    segment.lastCommitResult = commitResult;
  };

  let committedSnapshotPromise: Promise<Readonly<{
    persisted: boolean;
    commitResult: SessionMessageCommitResult | null;
  }>>;
  try {
    // The causal outbox is opt-in at the producer boundary: only a producer that supplied
    // explicit provenance may enter it. Unmigrated producers keep their established direct
    // commit path instead of accumulating permanently blocked outbox records.
    if (segment.commitMode === 'exact') {
      if (typeof session.sendAgentMessageCommittedExact !== 'function') {
        throw new Error('sendAgentMessageCommittedExact unavailable for exact transcript segment');
      }
      committedSnapshotPromise = session
        .sendAgentMessageCommittedExact(provider, body, {
          localId: durableLocalId,
          meta,
        })
        .then((commitResult) => {
          if (commitResult.localId !== durableLocalId) {
            throw new Error(`Exact transcript segment ACK localId mismatch for ${durableLocalId}`);
          }
          return { persisted: true, commitResult };
        });
    } else if (segment.provenance && typeof session.enqueueAgentMessageCommitted === 'function') {
      committedSnapshotPromise = session
        .enqueueAgentMessageCommitted(provider, body, {
          localId: durableLocalId,
          meta,
          provenance: segment.provenance,
        })
        .then((result) => ({ persisted: result.persisted, commitResult: null }));
    } else if (typeof session.sendAgentMessageCommitted === 'function') {
      committedSnapshotPromise = session
        .sendAgentMessageCommitted(provider, body, {
          localId: durableLocalId,
          meta,
          ...(segment.provenance ? { provenance: segment.provenance } : {}),
        })
        .then(() => ({ persisted: true, commitResult: null }));
    } else {
      throw new Error('sendAgentMessageCommitted unavailable');
    }
  } catch (error) {
    committedSnapshotPromise = Promise.reject(error);
  }

  void committedSnapshotPromise
    .then((result) => {
      if (result.persisted) markDurablyPersisted(result.commitResult);
    })
    .catch(async (error) => {
      segment.lastCommitFailedAtMs = Date.now();
      segment.lastCommitError = error;
      logger.debug(
        segment.commitMode === 'exact'
          ? '[StreamedTranscriptWriter] Exact durable snapshot commit failed'
          : '[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)',
        {
          error: serializeAxiosErrorForLog(error),
          localId: durableLocalId,
          segmentLocalId: segment.segmentLocalId,
          kind: segment.kind,
          sidechainId: segment.sidechainId,
          state,
          textLength: commitTextLen,
          textVersion: commitVersion,
          lastCommittedTextVersion: segment.lastCommittedTextVersion,
          lastCommittedState: segment.lastCommittedState,
        },
      );
    })
    .finally(() => {
      segment.isCommittingDurable = false;
      const pendingCommit = segment.pendingDurableCommit;
      segment.pendingDurableCommit = null;
      if (pendingCommit) {
        commitStreamedTranscriptSegmentSnapshot({
          provider,
          session,
          segment,
          state: pendingCommit.state,
          interruptedReason: pendingCommit.interruptedReason,
        });
        return;
      }
      if (segment.idleWaiters.length === 0) return;
      const waiters = segment.idleWaiters.splice(0, segment.idleWaiters.length);
      for (const waiter of waiters) {
        waiter();
      }
    });
}
