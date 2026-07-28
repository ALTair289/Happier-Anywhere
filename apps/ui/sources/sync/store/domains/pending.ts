import type { Message } from '../../domains/messages/messageTypes';
import { isRecoveredHistoryTranscriptObservation } from '../../domains/messages/transcriptObservationProvenance';
import type { DiscardedPendingMessage, PendingMessage } from '../../domains/state/storageTypes';
import { shouldPreservePendingProjectionAfterCommittedUserLocalId } from '../../domains/pending/pendingTranscriptProjection';

import type { StoreGet, StoreSet } from './_shared';

export type SessionPending = {
    messages: PendingMessage[];
    discarded: DiscardedPendingMessage[];
    isLoaded: boolean;
};

export type PendingDomain = {
    sessionPending: Record<string, SessionPending>;
    applyPendingLoaded: (sessionId: string) => void;
    applyPendingSnapshot: (sessionId: string, snapshot: Readonly<{
        messages: PendingMessage[];
        discarded: DiscardedPendingMessage[];
    }>) => void;
    applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => void;
    applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => void;
    pruneServerPendingMessages: (sessionId: string) => void;
    upsertPendingMessage: (sessionId: string, message: PendingMessage) => void;
    removePendingMessage: (sessionId: string, pendingId: string) => void;
};

type PendingDomainDependencies = {
    sessionMessages?: Record<string, {
        messagesById?: Record<string, Message>;
        messagesMap?: Record<string, Message>;
    } | undefined>;
};

function collectCommittedUserLocalIds<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    candidateLocalIds: ReadonlySet<string>,
): Set<string> {
    if (candidateLocalIds.size === 0) return new Set();

    const sessionMessages = state.sessionMessages?.[sessionId];
    const messagesById = sessionMessages?.messagesById ?? sessionMessages?.messagesMap;
    if (!messagesById) return new Set();

    const committed = new Set<string>();
    for (const message of Object.values(messagesById)) {
        if (
            message?.kind !== 'user-text'
            || isRecoveredHistoryTranscriptObservation(message)
        ) continue;
        const localId = typeof message.localId === 'string' ? message.localId : '';
        if (localId && candidateLocalIds.has(localId)) {
            committed.add(localId);
        }
    }
    return committed;
}

function filterUncommittedPendingMessages<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    messages: PendingMessage[],
): PendingMessage[] {
    const candidateLocalIds = new Set<string>();
    for (const message of messages) {
        if (message.localId) candidateLocalIds.add(message.localId);
    }

    const committedLocalIds = collectCommittedUserLocalIds(state, sessionId, candidateLocalIds);
    if (committedLocalIds.size === 0) return messages;

    return messages.filter((message) => {
        if (!message.localId || !committedLocalIds.has(message.localId)) return true;
        return shouldPreservePendingProjectionAfterCommittedUserLocalId(message);
    });
}

function isPendingMessageAlreadyCommitted<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    message: PendingMessage,
): boolean {
    if (!message.localId) return false;
    if (shouldPreservePendingProjectionAfterCommittedUserLocalId(message)) return false;
    return collectCommittedUserLocalIds(state, sessionId, new Set([message.localId])).size > 0;
}

function arePendingValuesEqual(previous: unknown, next: unknown): boolean {
    if (Object.is(previous, next)) return true;
    if (previous == null || next == null) return previous === next;

    if (Array.isArray(previous) || Array.isArray(next)) {
        if (!Array.isArray(previous) || !Array.isArray(next)) return false;
        if (previous.length !== next.length) return false;
        for (let index = 0; index < previous.length; index += 1) {
            if (!arePendingValuesEqual(previous[index], next[index])) return false;
        }
        return true;
    }

    if (typeof previous === 'object' || typeof next === 'object') {
        if (typeof previous !== 'object' || typeof next !== 'object') return false;
        const previousRecord = previous as Record<string, unknown>;
        const nextRecord = next as Record<string, unknown>;
        const previousKeys = Object.keys(previousRecord);
        const nextKeys = Object.keys(nextRecord);
        if (previousKeys.length !== nextKeys.length) return false;
        for (const key of previousKeys) {
            if (!(key in nextRecord)) return false;
            if (!arePendingValuesEqual(previousRecord[key], nextRecord[key])) return false;
        }
        return true;
    }

    return false;
}

function arePendingMessageListsEqual<T extends PendingMessage>(
    previous: readonly T[],
    next: readonly T[],
): boolean {
    if (previous === next) return true;
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
        if (!arePendingValuesEqual(previous[index], next[index])) return false;
    }
    return true;
}

function replacePendingBucket<S extends PendingDomain & PendingDomainDependencies>(
    state: S,
    sessionId: string,
    snapshot: Readonly<{
        messages: PendingMessage[];
        discarded: DiscardedPendingMessage[];
        isLoaded: boolean;
    }>,
): S {
    const filteredMessages = filterUncommittedPendingMessages(state, sessionId, snapshot.messages);
    const existing = state.sessionPending[sessionId];
    const nextMessages = existing && arePendingMessageListsEqual(existing.messages, filteredMessages)
        ? existing.messages
        : filteredMessages;
    const nextDiscarded = existing && arePendingMessageListsEqual(existing.discarded, snapshot.discarded)
        ? existing.discarded
        : snapshot.discarded;
    if (
        existing
        && existing.messages === nextMessages
        && existing.discarded === nextDiscarded
        && existing.isLoaded === snapshot.isLoaded
    ) {
        return state;
    }
    return {
        ...state,
        sessionPending: {
            ...state.sessionPending,
            [sessionId]: {
                messages: nextMessages,
                discarded: nextDiscarded,
                isLoaded: snapshot.isLoaded,
            },
        },
    };
}

export function createPendingDomain<S extends PendingDomain & PendingDomainDependencies>({
    set,
    get: _get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): PendingDomain {
    return {
        sessionPending: {},
        applyPendingLoaded: (sessionId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (existing?.isLoaded === true) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: existing?.messages ?? [],
                        discarded: existing?.discarded ?? [],
                        isLoaded: true
                    }
                }
            };
        }),
        applyPendingSnapshot: (sessionId, snapshot) => set((state) => replacePendingBucket(state, sessionId, {
            ...snapshot,
            isLoaded: true,
        })),
        applyPendingMessages: (sessionId, messages) => set((state) => replacePendingBucket(state, sessionId, {
            messages,
            discarded: state.sessionPending[sessionId]?.discarded ?? [],
            isLoaded: true,
        })),
        applyDiscardedPendingMessages: (sessionId, discarded) => set((state) => replacePendingBucket(state, sessionId, {
            messages: state.sessionPending[sessionId]?.messages ?? [],
            discarded,
            isLoaded: state.sessionPending[sessionId]?.isLoaded ?? false,
        })),
        pruneServerPendingMessages: (sessionId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (!existing || existing.messages.length === 0) return state;
            const nextMessages = existing.messages.filter((message) => {
                if (message.source === 'server_pending') return false;
                const acceptedOrdinaryServerProjection =
                    message.source === 'local_outbound'
                    && message.deliveryStatus === 'accepted'
                    && message.pendingOutboxOperation === undefined
                    && message.pendingOutboxQuarantineReason === undefined
                    && (
                        message.pendingDeliveryStatus === undefined
                        || message.pendingDeliveryStatus === 'server_queued'
                        || message.pendingDeliveryStatus === 'server_delivering'
                    );
                return !acceptedOrdinaryServerProjection;
            });
            if (nextMessages.length === existing.messages.length) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: nextMessages,
                    },
                },
            };
        }),
        upsertPendingMessage: (sessionId: string, message: PendingMessage) => set((state) => {
            if (isPendingMessageAlreadyCommitted(state, sessionId, message)) {
                return state;
            }
            const existing = state.sessionPending[sessionId] ?? { messages: [], discarded: [], isLoaded: false };
            const idx = existing.messages.findIndex((m) => m.id === message.id);
            if (idx >= 0 && arePendingValuesEqual(existing.messages[idx], message)) {
                return state;
            }
            const next = idx >= 0
                ? [...existing.messages.slice(0, idx), message, ...existing.messages.slice(idx + 1)]
                : [...existing.messages, message];
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: next,
                        discarded: existing.discarded,
                        isLoaded: existing.isLoaded
                    }
                }
            };
        }),
        removePendingMessage: (sessionId: string, pendingId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (!existing) return state;
            const nextMessages = existing.messages.filter((m) => m.id !== pendingId);
            if (nextMessages.length === existing.messages.length) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: nextMessages
                    }
                }
            };
        }),
    };
}
