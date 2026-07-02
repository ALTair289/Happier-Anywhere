import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import type { RawJSONLines } from '@/backends/claude/types';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import type { AgentState, Metadata } from '../types';
import type { TurnAssistantTextSnapshot } from './turnAssistantTextSnapshot';
import type { CommittedUserMessageSeqWaitOptions } from './committedUserMessageSeqTracker';
import type { SessionTurnLifecycleController } from '@/agent/runtime/session/turn/types';
import type { PendingQueueReadOptions, PendingQueueReconcileWhenEmpty } from './pendingQueueReadPolicy';
import type { PendingMaterializationActiveTurnPolicy } from './pendingMaterializationActiveTurnPolicy';
import type { ProviderOwnedUserMessageEchoClassifier } from './providerOwnedUserMessageEcho';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type {
  PendingMaterializationDeliveryState,
  PendingQueueDeliveryBlockedReason,
} from './pendingQueueV2Transport';
import type {
  SessionPendingQueueDeliveryTiming,
  SessionRuntimeActivitySourceClassV1,
  SessionSystemRecord,
  SessionSystemRecordNamespace,
  SessionSystemRecordUpsertRequest,
} from '@happier-dev/protocol';

export type MaterializeNextPendingResult =
  | {
    type: 'materialized';
    localId: string;
    seq: number | null;
    content: unknown | null;
    createdAt?: number;
    updatedAt?: number;
    deliveryState?: PendingMaterializationDeliveryState;
  }
  | { type: 'no_pending' }
  | { type: 'deferred'; reason: 'supervisor_offline' | 'supervisor_auth_failed' | 'runtime_activity_active' };

export type UserMessageProviderAcceptanceQuery = Readonly<{
  userMessageSeq?: number | null | undefined;
  userMessageSeqs?: readonly number[] | null | undefined;
  localIds?: readonly string[] | null | undefined;
}>;

export type ProviderAcceptancePendingMaterializationPolicy =
  | 'claimUntilProviderAccept'
  | 'commitAtMaterialize';

export type ProviderAcceptanceDeliveryOptions = Readonly<{
  pendingMaterialization?: ProviderAcceptancePendingMaterializationPolicy;
}>;

export type SessionUserMessageDeliveryInfo = Readonly<{
  seq: number | null;
  providerAcceptancePending?: boolean | undefined;
}>;

export interface SessionClientPort {
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;

  sendSessionEvent(event: SessionEventMessage, id?: string): void;
  sendClaudeSessionMessage(message: RawJSONLines, meta?: Record<string, unknown>): void;
  recordClaudeJsonlMessageConsumed?(message: RawJSONLines, meta?: Record<string, unknown>): void;
  setSessionRuntimeControls?(controls: SessionRuntimeControls | null): void;
  registerSessionRuntimeControls?(controls: Partial<SessionRuntimeControls> | null): () => void;
  setProviderOwnedUserMessageEchoClassifier?(classifier: ProviderOwnedUserMessageEchoClassifier | null): void;
  hasActiveCanonicalTurn?(): boolean;
  fetchCommittedClaudeJsonlMessageBaseline?(opts?: { take?: number }): Promise<import('@/backends/claude/utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline>;
  fetchRecentTranscriptTextItemsForAcpImport?(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>>;
  sendAgentMessage(provider: ACPProvider, body: ACPMessageData, opts?: { localId?: string; meta?: Record<string, unknown> }): void;
  sendAgentMessageCommitted(provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }): Promise<void>;
  sendAgentMessageEphemeral?(
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
  ): void;

  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void>;
  updateRuntimeActivityProjection?(projection: Readonly<{
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityExpiresAt: number | null;
    runtimeActivitySourceClass: SessionRuntimeActivitySourceClassV1 | null;
  }>): Promise<void> | void;
  upsertSessionSystemRecord?(request: SessionSystemRecordUpsertRequest): Promise<void>;
  fetchSessionSystemRecord?(params: Readonly<{
    namespace: SessionSystemRecordNamespace;
    localId: string;
  }>): Promise<SessionSystemRecord | null>;
  getStoredContentEncryptionContext?(): Readonly<{
    mode: SessionStoredContentEncryptionMode;
    ctx?: SessionEncryptionContext;
  }>;
  getAgentStateSnapshot?(): AgentState | null;
  sessionTurnLifecycle?: SessionTurnLifecycleController;

  keepAlive(thinking: boolean, mode: 'local' | 'remote'): void;

  getMetadataSnapshot(): Metadata | null;
  /**
   * A3-HIGH-1 owed-delivery watermark: launchers whose consumption path confirms provider
   * acceptance opt in so the watermark stops persisting at queue handoff…
   */
  deferDeliveredUserMessageWatermarkToProviderAcceptance?(options?: ProviderAcceptanceDeliveryOptions): void;
  /** …and persist it here once the provider actually accepted the batch (null seq = local-id join). */
  confirmUserMessageDeliveredToProvider?(
    seq: number | null | undefined,
    opts?: { localIds?: readonly string[] | null },
  ): void;
  hasUserMessageProviderAcceptance?(query: UserMessageProviderAcceptanceQuery): boolean;
  blockPendingMessageDelivery?(params: Readonly<{
    localIds: readonly string[] | null | undefined;
    reason: PendingQueueDeliveryBlockedReason;
  }>): Promise<boolean>;
  getLastObservedMessageSeq?(): number;
  getCommittedUserMessageSeq?(localId: string): number | null;
  waitForCommittedUserMessageSeq?(
    localId: string,
    options?: CommittedUserMessageSeqWaitOptions,
  ): Promise<number | null>;
  beginTurnAssistantTextSnapshot?(params?: { turnToken?: string; startSeqExclusive?: number | null }): string;
  getTurnAssistantTextSnapshot?(params: {
    turnToken?: string | null;
    startSeqExclusive?: number | null;
  }): TurnAssistantTextSnapshot | null;
  waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  shouldAttemptPendingMaterialization?(opts?: {
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  }): boolean;
  reconcilePendingQueueState?(opts?: { force?: boolean }): Promise<boolean>;
  materializeNextPendingMessageSafely?(opts?: {
    reconcileWhenEmpty?: PendingQueueReconcileWhenEmpty;
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  }): Promise<MaterializeNextPendingResult>;
  popPendingMessage(): Promise<boolean>;

  peekPendingMessageQueueV2Count(opts?: PendingQueueReadOptions): Promise<number>;
  discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number>;
  discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number>;

  sendSessionDeath(): void;
  flush(): Promise<void>;
  close(): Promise<void>;

  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}
