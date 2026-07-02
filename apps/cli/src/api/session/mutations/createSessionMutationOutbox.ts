import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { isAuthenticationError } from '@/api/client/httpStatusError';

import {
    resolveSessionMutationRetryDelayMs,
    resolveSessionMutationTranscriptFlushBatchLimit,
} from './sessionMutationBackoff';
import {
    appendSessionMutationDeadLetters,
    createSessionMutationDeadLetterEntry,
    loadSessionMutationOutbox,
    parseQueuedSessionMutation,
    saveSessionMutationOutbox,
} from './sessionMutationPersistence';
import { deliverSessionTurnMutation, type UnsupportedSessionTurnMutationDiagnostic } from './deliverSessionTurnMutation';
import { deliverSessionEndMutation } from './deliverSessionEndMutation';
import { deliverTranscriptMessageMutation } from './deliverTranscriptMessageMutation';
import {
    createDeliveryDiagnostic,
    deadLetterDependentMutations,
    shouldDeadLetterFailedMutation,
    type SessionMutationDeliveryOutcome,
} from './sessionMutationOutboxFailureHandling';
import { withSessionMutationDeliverySlot } from './sessionMutationDeliveryLimiter';
import type {
    QueuedSessionMutation,
    SessionEndMutationV1,
    TranscriptMessageAppendMutationV1,
    SessionTurnMutationV1,
} from './sessionMutationTypes';
import { resolveTranscriptMessageAppendMutationId } from './sessionMutationTypes';
import type { SessionMutationDeadLetterEntry } from './sessionMutationPersistence';

export type SessionMutationSocket = {
    connected?: boolean;
    emit: (event: string, ...args: unknown[]) => unknown;
    emitWithAck: (event: string, ...args: unknown[]) => Promise<unknown>;
    timeout?: (ms: number) => SessionMutationSocket;
};

export type SessionMutationOutbox = Readonly<{
    enqueueSessionTurn(mutation: SessionTurnMutationV1): Promise<void>;
    enqueueSessionEnd(mutation: SessionEndMutationV1): Promise<void>;
    enqueueTranscriptMessage(mutation: TranscriptMessageAppendMutationV1): Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
    close(): Promise<void>;
}>;

type CreateSessionMutationOutboxParams = Readonly<{
    token: string;
    sessionId: string;
    getSocket: () => SessionMutationSocket;
    requestReconnect: (reason: string) => void;
}>;

const loggedUnsupportedSessionTurnMutationDiagnostics = new Set<string>();

function createQueuedSessionTurn(mutation: SessionTurnMutationV1): QueuedSessionMutation {
    const now = Date.now();
    return {
        kind: 'session_turn',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function createQueuedSessionEnd(mutation: SessionEndMutationV1): QueuedSessionMutation {
    const now = Date.now();
    return {
        kind: 'session_end',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function createQueuedTranscriptMessage(mutation: TranscriptMessageAppendMutationV1): QueuedSessionMutation {
    const now = Date.now();
    const canonicalMutationId = resolveTranscriptMessageAppendMutationId({
        sessionId: mutation.sessionId,
        localId: mutation.localId,
    });
    if (mutation.mutationId !== canonicalMutationId) {
        throw new Error('Transcript append mutation id must match the canonical session/localId key');
    }
    return {
        kind: 'transcript_message_append',
        mutationId: canonicalMutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function readTranscriptSidechain(mutation: QueuedSessionMutation): string | null | undefined {
    if (mutation.kind !== 'transcript_message_append') return undefined;
    return mutation.payload.sidechainId ?? null;
}

function readTranscriptCoalesceKey(mutation: QueuedSessionMutation): string | null {
    if (mutation.kind !== 'transcript_message_append') return null;
    return resolveTranscriptMessageAppendMutationId({
        sessionId: mutation.payload.sessionId,
        localId: mutation.payload.localId,
    });
}

function readQueuedMutationObservedAt(mutation: QueuedSessionMutation): number {
    if (mutation.kind === 'transcript_message_append') {
        return Number.isFinite(mutation.payload.updatedAt) ? mutation.payload.updatedAt : mutation.createdAt;
    }
    const observedAt = mutation.payload.observedAt;
    return Number.isFinite(observedAt) ? observedAt : mutation.createdAt;
}

function readQueuedMutationCoalesceKey(mutation: QueuedSessionMutation): string | null {
    const transcriptKey = readTranscriptCoalesceKey(mutation);
    if (transcriptKey) return transcriptKey;
    if (mutation.kind === 'session_end') return `session_end:${mutation.payload.sessionId}`;
    return null;
}

function readTranscriptUpdatedAt(mutation: QueuedSessionMutation): number {
    if (mutation.kind !== 'transcript_message_append') return Number.NEGATIVE_INFINITY;
    return Number.isFinite(mutation.payload.updatedAt) ? mutation.payload.updatedAt : mutation.createdAt;
}

function shouldReplaceCoalescedMutation(existing: QueuedSessionMutation, next: QueuedSessionMutation): boolean {
    if (existing.kind === 'transcript_message_append' && next.kind === 'transcript_message_append') {
        return readTranscriptUpdatedAt(next) >= readTranscriptUpdatedAt(existing);
    }
    if (existing.kind === 'session_end' && next.kind === 'session_end') {
        return readQueuedMutationObservedAt(next) >= readQueuedMutationObservedAt(existing);
    }
    return true;
}

function assertTranscriptCoalescingCompatible(
    mutation: QueuedSessionMutation,
    queued: readonly QueuedSessionMutation[],
): void {
    if (mutation.kind !== 'transcript_message_append') return;
    const nextCoalesceKey = readTranscriptCoalesceKey(mutation);
    const nextSidechainId = readTranscriptSidechain(mutation);
    const conflicting = queued.find((candidate) => (
        readTranscriptCoalesceKey(candidate) === nextCoalesceKey
        && candidate.kind === 'transcript_message_append'
        && readTranscriptSidechain(candidate) !== nextSidechainId
    ));
    if (!conflicting) return;
    throw new Error('Cannot coalesce transcript snapshot with reused localId across different sidechains');
}

function resolveUnsupportedDiagnosticKey(diagnostic: UnsupportedSessionTurnMutationDiagnostic): string {
    return [
        diagnostic.serverOrigin,
        diagnostic.sessionId,
        diagnostic.socket.transport,
        diagnostic.socket.evidence,
        diagnostic.http.transport,
        diagnostic.http.evidence,
        diagnostic.http.status,
    ].join(':');
}

function logUnsupportedSessionTurnMutationDiagnostic(diagnostic: UnsupportedSessionTurnMutationDiagnostic): void {
    const key = resolveUnsupportedDiagnosticKey(diagnostic);
    if (loggedUnsupportedSessionTurnMutationDiagnostics.has(key)) return;
    loggedUnsupportedSessionTurnMutationDiagnostics.add(key);
    logger.debug('[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued', diagnostic);
}

function mergeQueuedSessionMutations(
    earlier: readonly QueuedSessionMutation[],
    later: readonly QueuedSessionMutation[],
): QueuedSessionMutation[] {
    const merged = [...earlier];
    for (const mutation of later) {
        const mutationCoalesceKey = readQueuedMutationCoalesceKey(mutation);
        const existingIndex = merged.findIndex((queued) => (
            mutationCoalesceKey
                ? readQueuedMutationCoalesceKey(queued) === mutationCoalesceKey
                : queued.mutationId === mutation.mutationId
        ));
        if (existingIndex >= 0) {
            if (shouldReplaceCoalescedMutation(merged[existingIndex], mutation)) {
                merged[existingIndex] = mutation;
            }
        } else {
            merged.push(mutation);
        }
    }
    return merged;
}

function pruneSessionEndsSupersededByLaterTurnBegins(
    queued: readonly QueuedSessionMutation[],
): QueuedSessionMutation[] {
    let latestTurnBeginObservedAt = -Infinity;
    for (const mutation of queued) {
        if (mutation.kind !== 'session_turn' || mutation.payload.action !== 'begin') continue;
        latestTurnBeginObservedAt = Math.max(latestTurnBeginObservedAt, readQueuedMutationObservedAt(mutation));
    }
    if (!Number.isFinite(latestTurnBeginObservedAt)) return [...queued];
    return queued.filter((mutation) => (
        mutation.kind !== 'session_end'
        || readQueuedMutationObservedAt(mutation) >= latestTurnBeginObservedAt
    ));
}

export function createSessionMutationOutbox(params: CreateSessionMutationOutboxParams): SessionMutationOutbox {
    let closed = false;
    let mutations: QueuedSessionMutation[] = [];
    let inFlightMutations: QueuedSessionMutation[] = [];
    let flushInFlight: Promise<void> | null = null;
    let persistTail: Promise<void> = Promise.resolve();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let loadedMutationsNeedPersist = false;

    const ready = loadSessionMutationOutbox(params.sessionId)
        .then((loaded) => {
            mutations = mergeQueuedSessionMutations([], pruneSessionEndsSupersededByLaterTurnBegins(loaded));
            loadedMutationsNeedPersist = mutations.length !== loaded.length;
        })
        .catch((error) => {
            logger.debug('[API] Failed to load durable session mutation outbox', {
                sessionId: params.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });

    async function persist(): Promise<void> {
        const runPersist = async () => {
            await saveSessionMutationOutbox(
                params.sessionId,
                pruneSessionEndsSupersededByLaterTurnBegins(
                    mergeQueuedSessionMutations(inFlightMutations, mutations),
                ),
            );
        };
        const persistPromise = persistTail.then(runPersist, runPersist);
        persistTail = persistPromise.catch(() => {});
        await persistPromise;
    }

    function clearRetryTimer(): void {
        if (!retryTimer) return;
        clearTimeout(retryTimer);
        retryTimer = null;
    }

    function scheduleRetry(): void {
        if (closed || retryTimer || mutations.length === 0) return;
        const now = Date.now();
        const nextAttemptAt = Math.min(...mutations.map((mutation) => mutation.nextAttemptAt || now));
        const delayMs = Math.max(0, nextAttemptAt - now);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void flush('timer');
        }, delayMs);
        retryTimer.unref?.();
    }

    async function deliver(mutation: QueuedSessionMutation): Promise<SessionMutationDeliveryOutcome> {
        if (mutation.kind === 'session_turn') {
            const result = await deliverSessionTurnMutation({
                token: params.token,
                socket: params.getSocket(),
                mutation: mutation.payload,
            });
            if (result.status === 'unsupported_capability') {
                logUnsupportedSessionTurnMutationDiagnostic(result.diagnostic);
            }
            return result;
        }
        if (mutation.kind === 'transcript_message_append') {
            return await deliverTranscriptMessageMutation({
                token: params.token,
                socket: params.getSocket(),
                mutation: mutation.payload,
            });
        }
        return await deliverSessionEndMutation({
            token: params.token,
            socket: params.getSocket(),
            mutation: mutation.payload,
        });
    }

    async function flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void> {
        await ready;
        if (closed && reason !== 'flush') return;
        if (flushInFlight) {
            await flushInFlight;
            if (reason !== 'timer') {
                await flush(reason);
            }
            return;
        }
        flushInFlight = (async () => {
            clearRetryTimer();
            const now = Date.now();
            let didChange = loadedMutationsNeedPersist;
            loadedMutationsNeedPersist = false;
            let shouldRequestReconnect = false;
            const remaining: QueuedSessionMutation[] = [];
            const prunedMutations = pruneSessionEndsSupersededByLaterTurnBegins(mutations);
            if (prunedMutations.length !== mutations.length) {
                mutations = prunedMutations;
                didChange = true;
            }
            const batch = mutations;
            mutations = [];
            inFlightMutations = batch;
            const deadLetters: SessionMutationDeadLetterEntry[] = [];
            const transcriptFlushBatchLimit = reason === 'flush'
                ? Number.POSITIVE_INFINITY
                : resolveSessionMutationTranscriptFlushBatchLimit();
            let transcriptDeliveriesThisFlush = 0;
            const refreshInFlightMutations = (nextIndex: number) => {
                inFlightMutations = mergeQueuedSessionMutations(remaining, batch.slice(nextIndex));
            };
            for (let index = 0; index < batch.length; index += 1) {
                const mutation = batch[index];
                if (reason !== 'flush' && mutation.nextAttemptAt > now) {
                    if (mutation.kind === 'transcript_message_append') {
                        remaining.push(mutation);
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                    remaining.push(mutation);
                    remaining.push(...batch.slice(index + 1));
                    inFlightMutations = [];
                    break;
                }
                const parsedMutation = parseQueuedSessionMutation(mutation, params.sessionId);
                if (!parsedMutation.ok) {
                    deadLetters.push(parsedMutation.deadLetter);
                    const nextIndex = deadLetterDependentMutations({
                        batch,
                        startIndex: index + 1,
                        failedMutation: mutation,
                        deadLetters,
                    });
                    refreshInFlightMutations(nextIndex);
                    index = nextIndex - 1;
                    didChange = true;
                    continue;
                }
                if (
                    reason !== 'flush'
                    && mutation.kind === 'transcript_message_append'
                    && transcriptDeliveriesThisFlush >= transcriptFlushBatchLimit
                ) {
                    remaining.push({
                        ...mutation,
                        nextAttemptAt: Math.max(
                            mutation.nextAttemptAt,
                            Date.now() + resolveSessionMutationRetryDelayMs(0),
                        ),
                    } as QueuedSessionMutation);
                    refreshInFlightMutations(index + 1);
                    didChange = true;
                    continue;
                }
                if (mutation.kind === 'transcript_message_append') {
                    transcriptDeliveriesThisFlush += 1;
                }
                try {
                    const outcome = await withSessionMutationDeliverySlot(() => deliver(mutation));
                    if (outcome.status === 'delivered' || outcome.status === 'ignored_lossy') {
                        didChange = true;
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                    const attempts = mutation.attempts + 1;
                    const failedMutation = {
                        ...mutation,
                        attempts,
                        nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(attempts),
                    } as QueuedSessionMutation;
                    if (shouldDeadLetterFailedMutation(failedMutation, Date.now(), outcome)) {
                        deadLetters.push(createSessionMutationDeadLetterEntry({
                            sessionId: params.sessionId,
                            mutation: failedMutation,
                            reason: 'retry_exhausted',
                            diagnostic: createDeliveryDiagnostic(outcome),
                        }));
                        const nextIndex = deadLetterDependentMutations({
                            batch,
                            startIndex: index + 1,
                            failedMutation,
                            deadLetters,
                        });
                        refreshInFlightMutations(nextIndex);
                        index = nextIndex - 1;
                        didChange = true;
                        continue;
                    }
                    remaining.push(failedMutation);
                    remaining.push(...batch.slice(index + 1));
                    inFlightMutations = [];
                    didChange = true;
                    shouldRequestReconnect = true;
                    break;
                } catch (error) {
                    if (isAuthenticationError(error)) {
                        remaining.push({
                            ...mutation,
                            nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(mutation.attempts + 1),
                        } as QueuedSessionMutation);
                        remaining.push(...batch.slice(index + 1));
                        inFlightMutations = [];
                        didChange = true;
                        break;
                    }
                    logger.debug('[API] Durable session mutation delivery failed', {
                        sessionId: params.sessionId,
                        mutationKind: mutation.kind,
                        mutationId: mutation.mutationId,
                        error: serializeAxiosErrorForLog(error),
                    });
                }

                const attempts = mutation.attempts + 1;
                const failedMutation = {
                    ...mutation,
                    attempts,
                    nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(attempts),
                } as QueuedSessionMutation;
                if (shouldDeadLetterFailedMutation(failedMutation, Date.now())) {
                    deadLetters.push(createSessionMutationDeadLetterEntry({
                        sessionId: params.sessionId,
                        mutation: failedMutation,
                        reason: 'retry_exhausted',
                        diagnostic: {
                            deliveryStatus: 'retryable',
                            reason: 'delivery_exception',
                        },
                    }));
                    const nextIndex = deadLetterDependentMutations({
                        batch,
                        startIndex: index + 1,
                        failedMutation,
                        deadLetters,
                    });
                    refreshInFlightMutations(nextIndex);
                    index = nextIndex - 1;
                    didChange = true;
                    continue;
                }
                remaining.push(failedMutation);
                remaining.push(...batch.slice(index + 1));
                inFlightMutations = [];
                didChange = true;
                shouldRequestReconnect = true;
                break;
            }
            mutations = mergeQueuedSessionMutations(remaining, mutations);
            inFlightMutations = [];
            if (didChange) {
                await appendSessionMutationDeadLetters(params.sessionId, deadLetters);
                await persist();
            }
            if (!closed && mutations.length > 0) {
                if (shouldRequestReconnect) {
                    params.requestReconnect(reason);
                }
                scheduleRetry();
            }
        })().finally(() => {
            flushInFlight = null;
        });
        await flushInFlight;
    }

    function hasQueuedMutation(mutationId: string): boolean {
        return (
            mutations.some((queued) => queued.mutationId === mutationId)
            || inFlightMutations.some((queued) => queued.mutationId === mutationId)
        );
    }

    async function enqueue(
        mutation: QueuedSessionMutation,
        opts: Readonly<{ awaitFlush?: boolean }> = {},
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        await ready;
        if (closed) return { persisted: false, delivered: false };
        assertTranscriptCoalescingCompatible(mutation, mutations);
        assertTranscriptCoalescingCompatible(mutation, inFlightMutations);
        const mutationCoalesceKey = readQueuedMutationCoalesceKey(mutation);
        const existingIndex = mutations.findIndex((queued) => (
            mutationCoalesceKey
                ? readQueuedMutationCoalesceKey(queued) === mutationCoalesceKey
                : queued.mutationId === mutation.mutationId
        ));
        if (existingIndex >= 0) {
            if (shouldReplaceCoalescedMutation(mutations[existingIndex], mutation)) {
                mutations[existingIndex] = mutation;
            }
        } else {
            mutations.push(mutation);
        }
        mutations = pruneSessionEndsSupersededByLaterTurnBegins(mutations);
        await persist();
        const flushPromise = flush('enqueue').catch((error) => {
            logger.debug('[API] Durable session mutation enqueue flush failed', {
                sessionId: params.sessionId,
                mutationKind: mutation.kind,
                mutationId: mutation.mutationId,
                error: serializeAxiosErrorForLog(error),
            });
        });
        if (opts.awaitFlush === true) {
            await flushPromise;
        } else {
            void flushPromise;
        }
        return { persisted: true, delivered: !hasQueuedMutation(mutation.mutationId) };
    }

    void ready.then(() => flush('startup')).catch(() => {});

    return {
        async enqueueSessionTurn(mutation) {
            await enqueue(createQueuedSessionTurn(mutation), {
                awaitFlush: mutation.action === 'fail' || mutation.action === 'cancel',
            });
        },
        async enqueueSessionEnd(mutation) {
            await enqueue(createQueuedSessionEnd(mutation));
        },
        async enqueueTranscriptMessage(mutation) {
            const result = await enqueue(createQueuedTranscriptMessage(mutation), { awaitFlush: true });
            return { persisted: result.persisted, delivered: result.delivered };
        },
        flush,
        async close() {
            closed = true;
            clearRetryTimer();
            await ready;
            await flush('flush');
            clearRetryTimer();
            await persist();
        },
    };
}
