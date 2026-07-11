import { randomUUID } from 'node:crypto';

import type {
    SessionRuntimeIssueV1,
    SessionMessageRole,
    SessionStoredMessageContent,
    SessionTurnMutationActionV1,
    SessionTurnTranscriptAnchorsV1,
    SessionTurnMutationV1,
} from '@happier-dev/protocol';

export type {
    SessionTurnMutationActionV1,
    SessionTurnMutationV1,
} from '@happier-dev/protocol';

export type SessionEndMutationV1 = Readonly<{
    v: 1;
    sessionId: string;
    mutationId: string;
    source: 'session_end';
    observedAt: number;
    exit?: unknown;
}>;

export type TranscriptMessageAppendMutationContentV1 =
    | string
    | SessionStoredMessageContent;

export type TranscriptMessageAppendMutationV1 = Readonly<{
    v: 1;
    sessionId: string;
    mutationId: string;
    source: 'transcript_message_append';
    localId: string;
    sidechainId?: string | null;
    messageRole?: SessionMessageRole;
    content: TranscriptMessageAppendMutationContentV1;
    createdAt: number;
    updatedAt: number;
    sessionEventType?: 'ready';
}>;

export function resolveTranscriptMessageAppendMutationId(params: Readonly<{
    sessionId: string;
    localId: string;
}>): string {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const localId = normalizeRequiredString(params.localId, 'localId');
    return `transcript:${sessionId}:${localId}`;
}

export type QueuedSessionMutation =
    | Readonly<{
        kind: 'session_turn';
        mutationId: string;
        payload: SessionTurnMutationV1;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
    }>
    | Readonly<{
        kind: 'session_end';
        mutationId: string;
        payload: SessionEndMutationV1;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
    }>
    | Readonly<{
        kind: 'transcript_message_append';
        mutationId: string;
        payload: TranscriptMessageAppendMutationV1;
        /** Client-local monotonic enqueue order; never sent in the server payload. */
        intentOrder?: number;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
}>;

export function createSessionTurnMutation(params: Readonly<{
    sessionId: string;
    action: SessionTurnMutationActionV1;
    turnId?: string;
    provider?: string | null;
    providerTurnId?: string | null;
    issue?: SessionRuntimeIssueV1 | null;
    transcriptAnchors?: SessionTurnTranscriptAnchorsV1;
    providerRollbackOrdinal?: number;
    restoredToTurnId?: string;
    reason?: string;
    mutationId?: string;
    observedAt?: number;
    now?: number;
}>): SessionTurnMutationV1 {
    const observedAt = normalizeObservedAt(params.observedAt ?? params.now ?? Date.now());
    const mutationId = params.mutationId ?? randomUUID();
    const provider = normalizeOptionalString(params.provider);
    const providerTurnId = normalizeOptionalString(params.providerTurnId);
    const turnId = normalizeOptionalString(params.turnId);
    return {
        v: 1,
        sessionId: params.sessionId,
        mutationId,
        action: params.action,
        ...(turnId ? { turnId } : {}),
        ...('issue' in params && params.issue ? { issue: params.issue } : {}),
        ...(params.transcriptAnchors !== undefined ? { transcriptAnchors: params.transcriptAnchors } : {}),
        ...(typeof params.providerRollbackOrdinal === 'number' ? { providerRollbackOrdinal: params.providerRollbackOrdinal } : {}),
        ...(params.restoredToTurnId ? { restoredToTurnId: params.restoredToTurnId } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
        ...(provider ? { provider } : {}),
        ...(providerTurnId !== undefined ? { providerTurnId } : {}),
        observedAt,
    } as SessionTurnMutationV1;
}

export function createSessionEndMutation(params: Readonly<{
    sessionId: string;
    observedAt?: number;
    exit?: unknown;
}>): SessionEndMutationV1 {
    return {
        v: 1,
        sessionId: params.sessionId,
        mutationId: randomUUID(),
        source: 'session_end',
        observedAt: normalizeObservedAt(params.observedAt ?? Date.now()),
        ...(params.exit !== undefined ? { exit: params.exit } : {}),
    };
}

export function createTranscriptMessageAppendMutation(params: Readonly<{
    sessionId: string;
    localId: string;
    content: TranscriptMessageAppendMutationContentV1;
    sidechainId?: string | null;
    messageRole?: SessionMessageRole;
    sessionEventType?: 'ready';
    createdAt?: number;
    updatedAt?: number;
}>): TranscriptMessageAppendMutationV1 {
    const localId = normalizeRequiredString(params.localId, 'localId');
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const createdAt = normalizeObservedAt(params.createdAt ?? Date.now());
    const updatedAt = normalizeObservedAt(params.updatedAt ?? createdAt);
    const sidechainId = normalizeOptionalString(params.sidechainId);
    return {
        v: 1,
        sessionId,
        mutationId: resolveTranscriptMessageAppendMutationId({ sessionId, localId }),
        source: 'transcript_message_append',
        localId,
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(params.messageRole ? { messageRole: params.messageRole } : {}),
        content: params.content,
        createdAt,
        updatedAt: Math.max(createdAt, updatedAt),
        ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
    };
}

function normalizeObservedAt(value: number): number {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : undefined;
}

function normalizeRequiredString(value: string | null | undefined, name: string): string {
    const normalized = normalizeOptionalString(value);
    if (!normalized) throw new Error(`${name} is required`);
    return normalized;
}
