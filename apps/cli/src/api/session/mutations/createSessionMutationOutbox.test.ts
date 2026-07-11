import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

vi.mock('axios');

let tempHomeDir: string | null = null;
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
const originalMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
const originalAckTimeoutMs = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
const originalTranscriptFlushBatchLimit = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT;
const originalDeliveryConcurrency = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY;

async function useTempHappyHome(): Promise<void> {
    tempHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-outbox-unit-'));
    process.env.HAPPIER_HOME_DIR = tempHomeDir;
}

async function readPersistedOutboxMutations(sessionId: string): Promise<unknown[]> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
        return Array.isArray(parsed.mutations) ? parsed.mutations : [];
    } catch {
        return [];
    }
}

async function readDeadLetterEntries(sessionId: string): Promise<unknown[]> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`);
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { entries?: unknown[] };
        return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
        return [];
    }
}

async function writeDeadLetterEntries(sessionId: string, entries: readonly unknown[]): Promise<void> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`);
    await mkdir(join(configuration.activeServerDir, 'session-mutations'), { recursive: true });
    await writeFile(filePath, JSON.stringify({ v: 1, entries }, null, 2), 'utf8');
}

function createDeferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

describe('createSessionMutationOutbox', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.doUnmock('./sessionMutationPersistence');
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.get).mockRejectedValue(new Error('session-end proof unavailable'));
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '2';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        await useTempHappyHome();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
        if (originalMaxAttempts === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = originalMaxAttempts;
        }
        if (originalBaseRetryMs === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
        }
        if (originalJitterMs === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
        }
        if (originalAckTimeoutMs === undefined) {
            delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
        } else {
            process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = originalAckTimeoutMs;
        }
        if (originalTranscriptFlushBatchLimit === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT = originalTranscriptFlushBatchLimit;
        }
        if (originalDeliveryConcurrency === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY = originalDeliveryConcurrency;
        }
        if (tempHomeDir) {
            await rm(tempHomeDir, { recursive: true, force: true });
            tempHomeDir = null;
        }
    });

    it('drops old-server touch_active schema rejections without blocking a later terminal turn mutation', async () => {
        const deliveredActions: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            const action = (body as { action?: unknown }).action;
            const normalizedAction = typeof action === 'string' ? action : 'unknown';
            deliveredActions.push(normalizedAction);
            if (normalizedAction === 'touch_active') {
                throw { response: { status: 400 } };
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket emit should not be reached while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const touchActive = createSessionTurnMutation({
            sessionId: 's1',
            action: 'touch_active',
            turnId: 'turn-compat',
            provider: 'codex',
            mutationId: 'mutation-touch-active',
            observedAt: 1_000,
        });
        const complete = createSessionTurnMutation({
            sessionId: 's1',
            action: 'complete',
            turnId: 'turn-compat',
            provider: 'codex',
            mutationId: 'mutation-complete',
            observedAt: 1_100,
        });
        await saveSessionMutationOutbox('s1', [
            {
                kind: 'session_turn',
                mutationId: touchActive.mutationId,
                payload: touchActive,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: complete.mutationId,
                payload: complete,
                createdAt: 1_100,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        expect(deliveredActions).toEqual(['touch_active', 'complete']);
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it.each([400, 422] as const)('keeps exhausted HTTP %s turn rejections queued instead of losing authoritative state', async (status) => {
        const deliveredTurnIds: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            const turnId = (body as { turnId?: unknown }).turnId;
            if (typeof turnId === 'string') deliveredTurnIds.push(turnId);
            if (turnId === 'turn-blocked') {
                throw { response: { status } };
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket emit should not be reached while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const blockedBegin = createSessionTurnMutation({
            sessionId: 's1',
            action: 'begin',
            turnId: 'turn-blocked',
            provider: 'codex',
            mutationId: 'mutation-blocked-begin',
            observedAt: 1_000,
        });
        const blockedComplete = createSessionTurnMutation({
            sessionId: 's1',
            action: 'complete',
            turnId: 'turn-blocked',
            provider: 'codex',
            mutationId: 'mutation-blocked-complete',
            observedAt: 1_100,
        });
        const independentBegin = createSessionTurnMutation({
            sessionId: 's1',
            action: 'begin',
            turnId: 'turn-independent',
            provider: 'codex',
            mutationId: 'mutation-independent-begin',
            observedAt: 2_000,
        });
        await saveSessionMutationOutbox('s1', [
            {
                kind: 'session_turn',
                mutationId: blockedBegin.mutationId,
                payload: blockedBegin,
                createdAt: 1_000,
                attempts: 1,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: blockedComplete.mutationId,
                payload: blockedComplete,
                createdAt: 1_100,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: independentBegin.mutationId,
                payload: independentBegin,
                createdAt: 2_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        expect(deliveredTurnIds).not.toContain('turn-independent');
        expect(deliveredTurnIds).not.toContain('turn-blocked-complete');
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-blocked-begin',
                attempts: 2,
            }),
            expect.objectContaining({ mutationId: 'mutation-blocked-complete' }),
            expect.objectContaining({ mutationId: 'mutation-independent-begin' }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it('retries authoritative turn mutations beyond max attempts and delivers after reconnect', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '0';
        let shouldFail = true;
        vi.mocked(axios.post).mockImplementation(async () => {
            if (shouldFail) {
                throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:41001'), {
                    isAxiosError: true,
                    code: 'ECONNREFUSED',
                });
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const complete = createSessionTurnMutation({
            sessionId: 's-authoritative-retry',
            action: 'complete',
            turnId: 'turn-1',
            provider: 'claude',
            mutationId: 'mutation-complete',
            observedAt: 1_100,
        });
        await saveSessionMutationOutbox('s-authoritative-retry', [{
            kind: 'session_turn',
            mutationId: complete.mutationId,
            payload: complete,
            createdAt: 1_100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-authoritative-retry',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');
        await outbox.flush('flush');

        await expect(readDeadLetterEntries('s-authoritative-retry')).resolves.toEqual([]);
        const persistedAfterFailures = await readPersistedOutboxMutations('s-authoritative-retry');
        expect(persistedAfterFailures).toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-complete',
            }),
        ]);
        expect((persistedAfterFailures[0] as { attempts?: unknown }).attempts).toBeGreaterThan(1);

        shouldFail = false;
        await outbox.flush('connect');

        expect(vi.mocked(axios.post).mock.calls.length).toBeGreaterThanOrEqual(3);
        await expect(readPersistedOutboxMutations('s-authoritative-retry')).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s-authoritative-retry')).resolves.toEqual([]);
        await outbox.close();
    });

    it('re-resolves the live server URL and retries a terminal turn mutation after a local endpoint refusal', async () => {
        const attemptedUrls: string[] = [];
        vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:41001');
        vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', '');
        vi.mocked(axios.post).mockImplementation(async (url) => {
            attemptedUrls.push(String(url));
            if (attemptedUrls.length === 1) {
                vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:52002');
                throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:41001'), {
                    isAxiosError: true,
                    code: 'ECONNREFUSED',
                });
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket emit should not be reached while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const complete = createSessionTurnMutation({
            sessionId: 's1',
            action: 'complete',
            turnId: 'turn-1',
            provider: 'claude',
            mutationId: 'mutation-complete',
            observedAt: 1_100,
        });
        await saveSessionMutationOutbox('s1', [{
            kind: 'session_turn',
            mutationId: complete.mutationId,
            payload: complete,
            createdAt: 1_100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.flush('flush');

        expect(attemptedUrls).toEqual([
            'http://127.0.0.1:41001/v1/sessions/s1/turns/mutations',
            'http://127.0.0.1:52002/v1/sessions/s1/turns/mutations',
        ]);
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it('serializes concurrent enqueue persists so an older save cannot overwrite a newer accepted mutation', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const saves: Array<{
            mutationIds: string[];
            resolve: () => void;
        }> = [];
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                loadSessionMutationOutbox: vi.fn(async () => []),
                saveSessionMutationOutbox: vi.fn(async (_sessionId: string, mutations: readonly { mutationId?: unknown }[]) => {
                    if (saves.length >= 2) return;
                    const deferred = createDeferred<void>();
                    saves.push({
                        mutationIds: mutations.map((mutation) => String(mutation.mutationId ?? '')),
                        resolve: () => deferred.resolve(),
                    });
                    await deferred.promise;
                }),
                appendSessionMutationDeadLetters: vi.fn(async () => undefined),
            };
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            sessionId: 's-concurrent-persist',
            token: 'token',
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
        });

        const first = outbox.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-concurrent-persist',
            action: 'begin',
            turnId: 'turn-a',
            mutationId: 'mutation-a-begin',
        }));
        await expect.poll(() => saves.length, { timeout: 100 }).toBe(1);
        const second = outbox.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-concurrent-persist',
            action: 'append_transcript_anchors',
            turnId: 'turn-b',
            mutationId: 'mutation-b-anchors',
        }));
        await Promise.resolve();
        await Promise.resolve();
        const concurrentSaveCountBeforeFirstCompletes = saves.length;

        saves[0].resolve();
        await first;
        await expect.poll(() => saves.length, { timeout: 100 }).toBe(2);
        saves[1].resolve();
        await second;

        expect(concurrentSaveCountBeforeFirstCompletes).toBe(1);
        expect(saves[1].mutationIds).toEqual(expect.arrayContaining([
            'mutation-a-begin',
            'mutation-b-anchors',
        ]));
    });

    it('keeps unsupported session turn mutations queued after retry exhaustion', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({ ok: false, errorCode: 'unsupported' }),
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const begin = createSessionTurnMutation({
            sessionId: 's1',
            action: 'begin',
            turnId: 'turn-unsupported',
            provider: 'codex',
            mutationId: 'mutation-unsupported-begin',
            observedAt: 1_000,
        });
        await saveSessionMutationOutbox('s1', [{
            kind: 'session_turn',
            mutationId: begin.mutationId,
            payload: begin,
            createdAt: 1_000,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-unsupported-begin',
                attempts: 1,
            }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it.each(['begin', 'touch_active'] as const)(
        'does not wait for non-terminal %s session turn delivery before resolving the enqueue',
        async (action) => {
            const delivery = createDeferred<unknown>();
            const socket = createApiSessionSocketStub({
                connected: true,
                emitWithAck: async () => await delivery.promise,
            });
            vi.mocked(axios.post).mockRejectedValue(new Error('HTTP fallback should not run after socket delivery'));
            const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
            const { createSessionTurnMutation } = await import('./sessionMutationTypes');
            const outbox = createSessionMutationOutbox({
                token: 'tok',
                sessionId: 's-non-terminal-turn-delivery',
                getSocket: () => socket,
                requestReconnect: () => {},
            });
            let enqueueSettled = false;
            const enqueue = outbox.enqueueSessionTurn(createSessionTurnMutation({
                sessionId: 's-non-terminal-turn-delivery',
                action,
                turnId: `turn-${action}`,
                provider: 'claude',
                mutationId: `mutation-${action}`,
                observedAt: 1_000,
            })).then(() => {
                enqueueSettled = true;
            });

            try {
                await expect.poll(() => socket.emitWithAck.mock.calls.length).toBe(1);
                await Promise.resolve();
                await Promise.resolve();

                expect(enqueueSettled).toBe(true);
                await expect(readPersistedOutboxMutations('s-non-terminal-turn-delivery')).resolves.toEqual([
                    expect.objectContaining({
                        kind: 'session_turn',
                        mutationId: `mutation-${action}`,
                    }),
                ]);
            } finally {
                delivery.resolve({ ok: true });
                await Promise.allSettled([enqueue]);
                await outbox.close();
            }
        },
    );

    it.each(['fail', 'cancel'] as const)(
        'awaits delivery flush before resolving terminal %s session turn enqueues',
        async (action) => {
            const delivery = createDeferred<unknown>();
            const socket = createApiSessionSocketStub({
                connected: true,
                emitWithAck: async () => await delivery.promise,
            });
            vi.mocked(axios.post).mockRejectedValue(new Error('HTTP fallback should not run after socket delivery'));
            const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
            const { createSessionTurnMutation } = await import('./sessionMutationTypes');
            const outbox = createSessionMutationOutbox({
                token: 'tok',
                sessionId: 's-terminal-turn-delivery',
                getSocket: () => socket,
                requestReconnect: () => {},
            });
            let enqueueSettled = false;
            const enqueue = outbox.enqueueSessionTurn(createSessionTurnMutation({
                sessionId: 's-terminal-turn-delivery',
                action,
                turnId: `turn-${action}`,
                provider: 'claude',
                ...(action === 'fail'
                    ? {
                        issue: {
                            v: 1,
                            scope: 'primary_session',
                            status: 'failed',
                            code: 'provider_session_error',
                            source: 'provider_session_error',
                            occurredAt: 1_000,
                            provider: 'claude',
                            sanitizedPreview: 'Claude terminal delivery failed',
                        },
                    }
                    : {}),
                mutationId: `mutation-${action}`,
                observedAt: 1_000,
            })).then(() => {
                enqueueSettled = true;
            });

            try {
                await expect.poll(() => socket.emitWithAck.mock.calls.length).toBe(1);
                await Promise.resolve();
                await Promise.resolve();

                expect(enqueueSettled).toBe(false);

                delivery.resolve({ ok: true });
                await enqueue;
                expect(enqueueSettled).toBe(true);
                await expect(readPersistedOutboxMutations('s-terminal-turn-delivery')).resolves.toEqual([]);
            } finally {
                delivery.resolve({ ok: true });
                await Promise.allSettled([enqueue]);
                await outbox.close();
            }
        },
    );

    it('keeps exhausted unsupported session-end mutations queued after legacy proof fails', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => {
                throw new Error('session-end should not use ack-based socket delivery');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionEndMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const sessionEnd = createSessionEndMutation({ sessionId: 's1', observedAt: 1_000 });
        await saveSessionMutationOutbox('s1', [{
            kind: 'session_end',
            mutationId: sessionEnd.mutationId,
            payload: sessionEnd,
            createdAt: 1_000,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_end',
                attempts: 1,
            }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it('coalesces repeated queued session-end mutations for the same session before retrying', async () => {
        const futureAttemptAt = Date.now() + 60_000;
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionEndMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const firstEnd = createSessionEndMutation({ sessionId: 's1', observedAt: 1_000 });
        const latestEnd = createSessionEndMutation({ sessionId: 's1', observedAt: 2_000 });
        const olderTrailingEnd = createSessionEndMutation({ sessionId: 's1', observedAt: 1_500 });
        await saveSessionMutationOutbox('s1', [
            {
                kind: 'session_end',
                mutationId: firstEnd.mutationId,
                payload: firstEnd,
                createdAt: 1_000,
                attempts: 1,
                nextAttemptAt: futureAttemptAt,
            },
            {
                kind: 'session_end',
                mutationId: latestEnd.mutationId,
                payload: latestEnd,
                createdAt: 2_000,
                attempts: 0,
                nextAttemptAt: futureAttemptAt,
            },
            {
                kind: 'session_end',
                mutationId: olderTrailingEnd.mutationId,
                payload: olderTrailingEnd,
                createdAt: 1_500,
                attempts: 0,
                nextAttemptAt: futureAttemptAt,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('connect');

        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toEqual({ time: 2_000 });
        await outbox.close();
    });

    it('persists a transcript committed snapshot when socket and HTTP delivery fail', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket should not be used while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Hello' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));

        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-1',
                payload: expect.objectContaining({
                    source: 'transcript_message_append',
                    localId: 'segment-1',
                    messageRole: 'agent',
                    content: expect.objectContaining({
                        t: 'plain',
                        v: expect.objectContaining({
                            content: expect.objectContaining({ text: 'Hello' }),
                        }),
                    }),
                }),
            }),
        ]);
        expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1);
        await outbox.close();
    });

    it('reports transcript snapshots as not persisted when enqueued after outbox close', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket should not be used while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.close();

        const result = await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-after-close',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Late' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));

        expect(result).toEqual({ persisted: false, delivered: false });
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
    });

    it('coalesces repeated transcript snapshots by localId and keeps the latest content', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Older' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Newest' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        }));

        const persisted = await readPersistedOutboxMutations('s1');
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted[0])).toContain('Newest');
        expect(JSON.stringify(persisted[0])).not.toContain('Older');
        await outbox.close();
    });

    it('uses enqueue intent order when the wall clock moves backward for a newer transcript revision', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Revision one' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Revision two' } } },
            createdAt: 900,
            updatedAt: 1_100,
        }));

        const persisted = await readPersistedOutboxMutations('s1');
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted[0])).toContain('Revision two');
        expect(JSON.stringify(persisted[0])).not.toContain('Revision one');
        await outbox.close();
    });

    it('keeps the newer persisted transcript snapshot when stale duplicate records load last', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const newer = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Persisted newer' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        });
        const older = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Persisted stale last' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        await saveSessionMutationOutbox('s1', [
            {
                kind: 'transcript_message_append',
                mutationId: newer.mutationId,
                payload: newer,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: older.mutationId,
                payload: older,
                createdAt: 1_010,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.flush('startup');

        const persisted = await readPersistedOutboxMutations('s1');
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted[0])).toContain('Persisted newer');
        expect(JSON.stringify(persisted[0])).not.toContain('Persisted stale last');
        await outbox.close();
    });

    it('does not let a stale in-flight transcript retry overwrite a newer queued snapshot', async () => {
        let rejectFirstPost: ((error: Error) => void) | null = null;
        vi.mocked(axios.post).mockImplementationOnce(async () => {
            await new Promise((_resolve, reject) => {
                rejectFirstPost = reject;
            });
            return { status: 200, data: { ok: true } } as never;
        });
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const oldMutation = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Older in-flight' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        await saveSessionMutationOutbox('s1', [{
            kind: 'transcript_message_append',
            mutationId: oldMutation.mutationId,
            payload: oldMutation,
            createdAt: 1_000,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        for (let i = 0; i < 20 && !rejectFirstPost; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (!rejectFirstPost) {
            throw new Error('expected old transcript delivery to be in flight');
        }
        const rejectOldDelivery: (error: Error) => void = rejectFirstPost;
        const enqueueNewer = outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Newer queued' } } },
            createdAt: 900,
            updatedAt: 1_000,
        }));
        rejectOldDelivery(new Error('old delivery failed'));
        await enqueueNewer;

        const persisted = await readPersistedOutboxMutations('s1');
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted[0])).toContain('Newer queued');
        expect(JSON.stringify(persisted[0])).not.toContain('Older in-flight');
        await outbox.close();
    });

    it('flushes only the latest coalesced transcript snapshot after reconnect', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '0';
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Part one' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Final answer' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        }));

        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } } as never);
        await outbox.flush('connect');

        expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({
            content: expect.objectContaining({
                v: expect.objectContaining({
                    content: expect.objectContaining({ text: 'Final answer' }),
                }),
            }),
            localId: 'segment-1',
            messageRole: 'agent',
        });
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it('rejects transcript coalescing when a reused localId changes sidechain', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            sidechainId: 'sc-a',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'A' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));

        await expect(outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            sidechainId: 'sc-b',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'B' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        }))).rejects.toThrow(/sidechain/i);
        await outbox.close();
    });

    it('preserves delivery order for transcript snapshots with different localIds', async () => {
        const deliveredLocalIds: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            const localId = (body as { localId?: unknown }).localId;
            if (typeof localId === 'string') deliveredLocalIds.push(localId);
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-a',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'A' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-b',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'B' } } },
            createdAt: 1_010,
            updatedAt: 1_200,
        }));

        expect(deliveredLocalIds).toEqual(['segment-a', 'segment-b']);
        await outbox.close();
    });

    it('dead-letters exhausted transcript retries without blocking independent session-end mutations', async () => {
        const deliveredUrls: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (url) => {
            deliveredUrls.push(String(url));
            if (String(url).includes('/messages')) {
                throw { response: { status: 503 } };
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const {
            createSessionEndMutation,
            createTranscriptMessageAppendMutation,
        } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const transcript = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'lost' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        const sessionEnd = createSessionEndMutation({ sessionId: 's1', observedAt: 2_000 });
        await saveSessionMutationOutbox('s1', [
            {
                kind: 'transcript_message_append',
                mutationId: transcript.mutationId,
                payload: transcript,
                createdAt: 1_000,
                attempts: 1,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_end',
                mutationId: sessionEnd.mutationId,
                payload: sessionEnd,
                createdAt: 2_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        expect(deliveredUrls.some((url) => url.includes('/messages'))).toBe(true);
        expect(deliveredUrls.some((url) => url.includes('/end'))).toBe(true);
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-1',
                reason: 'retry_exhausted',
            }),
        ]);
        await outbox.close();
    });

    it('recovers authoritative dead letters on reconnect without requeueing lossy transcript dead letters', async () => {
        const deliveredUrls: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (url) => {
            deliveredUrls.push(String(url));
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const {
            createSessionTurnMutation,
            createTranscriptMessageAppendMutation,
        } = await import('./sessionMutationTypes');
        const turn = createSessionTurnMutation({
            sessionId: 's-dead-letter-recovery',
            action: 'complete',
            turnId: 'turn-1',
            provider: 'claude',
            mutationId: 'mutation-recovered-complete',
            observedAt: 1_100,
        });
        const transcript = createTranscriptMessageAppendMutation({
            sessionId: 's-dead-letter-recovery',
            localId: 'segment-lost',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'lossy' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        await writeDeadLetterEntries('s-dead-letter-recovery', [
            {
                v: 1,
                kind: 'session_turn',
                sessionId: 's-dead-letter-recovery',
                mutationId: turn.mutationId,
                reason: 'retry_exhausted',
                attempts: 12,
                createdAt: 1_100,
                deadLetteredAt: 1_300,
                payloadSummary: {
                    keys: ['action', 'mutationId', 'observedAt', 'provider', 'sessionId', 'turnId', 'v'],
                    action: 'complete',
                    mutationId: turn.mutationId,
                    sessionId: 's-dead-letter-recovery',
                },
            },
            {
                v: 1,
                kind: 'transcript_message_append',
                sessionId: 's-dead-letter-recovery',
                mutationId: transcript.mutationId,
                reason: 'retry_exhausted',
                attempts: 12,
                createdAt: 1_000,
                deadLetteredAt: 1_300,
                queuedMutation: {
                    kind: 'transcript_message_append',
                    mutationId: transcript.mutationId,
                    payload: transcript,
                    createdAt: 1_000,
                    attempts: 12,
                    nextAttemptAt: 0,
                },
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-dead-letter-recovery',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('connect');
        await outbox.flush('connect');

        expect(deliveredUrls).toEqual([
            expect.stringMatching(/\/v1\/sessions\/s-dead-letter-recovery\/turns\/mutations$/),
        ]);
        await expect(readPersistedOutboxMutations('s-dead-letter-recovery')).resolves.toEqual([]);
        const deadLetters = await readDeadLetterEntries('s-dead-letter-recovery');
        expect(deadLetters[0]).toEqual(
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-recovered-complete',
                recoveryAttemptedAt: expect.any(Number),
            }),
        );
        expect(deadLetters[1]).toEqual(expect.objectContaining({
            kind: 'transcript_message_append',
            mutationId: 'transcript:s-dead-letter-recovery:segment-lost',
        }));
        expect(deadLetters[1]).not.toHaveProperty('recoveryAttemptedAt');
        await outbox.close();
    });

    it('keeps socket ACK timeouts queued and requests reconnect for transcript snapshots', async () => {
        process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '1';
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const requestReconnect = vi.fn();
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => await new Promise<never>(() => {}),
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect,
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'queued' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));

        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-1',
            }),
        ]);
        expect(requestReconnect).toHaveBeenCalled();
        await outbox.close();
    });

    it('sends transcript HTTP payloads with encrypted and plain content shapes', async () => {
        const deliveredBodies: unknown[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            deliveredBodies.push(body);
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'encrypted-1',
            messageRole: 'agent',
            content: 'encrypted-payload',
            createdAt: 1_000,
            updatedAt: 1_100,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'plain-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'plain' } } },
            createdAt: 1_200,
            updatedAt: 1_300,
        }));

        expect(deliveredBodies).toEqual([
            expect.objectContaining({
                ciphertext: 'encrypted-payload',
                localId: 'encrypted-1',
                messageRole: 'agent',
            }),
            expect.objectContaining({
                content: expect.objectContaining({
                    t: 'plain',
                    v: expect.objectContaining({
                        content: expect.objectContaining({ text: 'plain' }),
                    }),
                }),
                localId: 'plain-1',
                messageRole: 'agent',
            }),
        ]);
        await outbox.close();
    });

    it('caps transcript deliveries per reconnect flush without blocking other mutation kinds', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        const deliveredUrls: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (url) => {
            deliveredUrls.push(String(url));
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const {
            createSessionEndMutation,
            createTranscriptMessageAppendMutation,
        } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const firstTranscript = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'first' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        const secondTranscript = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'segment-2',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'second' } } },
            createdAt: 1_010,
            updatedAt: 1_200,
        });
        const sessionEnd = createSessionEndMutation({ sessionId: 's1', observedAt: 2_000 });
        await saveSessionMutationOutbox('s1', [
            {
                kind: 'transcript_message_append',
                mutationId: firstTranscript.mutationId,
                payload: firstTranscript,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: secondTranscript.mutationId,
                payload: secondTranscript,
                createdAt: 1_010,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_end',
                mutationId: sessionEnd.mutationId,
                payload: sessionEnd,
                createdAt: 2_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('connect');

        expect(deliveredUrls.filter((url) => url.includes('/messages'))).toHaveLength(1);
        expect(deliveredUrls.some((url) => url.includes('/end'))).toBe(true);
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-2',
            }),
        ]);
        await outbox.close();
    });

    it('limits durable deliveries globally across reattached session outboxes', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY = '1';
        const startedUrls: string[] = [];
        const releases: Array<() => void> = [];
        let activeDeliveries = 0;
        let maxActiveDeliveries = 0;
        vi.mocked(axios.post).mockImplementation(async (url) => {
            startedUrls.push(String(url));
            activeDeliveries += 1;
            maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
            await new Promise<void>((resolve) => {
                releases.push(resolve);
            });
            activeDeliveries -= 1;
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');

        for (const sessionId of ['s1', 's2']) {
            const mutation = createTranscriptMessageAppendMutation({
                sessionId,
                localId: `segment-${sessionId}`,
                messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: sessionId } } },
                createdAt: 1_000,
                updatedAt: 1_100,
            });
            await saveSessionMutationOutbox(sessionId, [{
                kind: 'transcript_message_append',
                mutationId: mutation.mutationId,
                payload: mutation,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            }]);
        }

        const outbox1 = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        const outbox2 = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's2',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        const flush1 = outbox1.flush('connect');
        const flush2 = outbox2.flush('connect');

        try {
            await expect.poll(() => startedUrls.length).toBeGreaterThanOrEqual(1);
            await Promise.resolve();
            await Promise.resolve();

            expect(startedUrls).toHaveLength(1);
            expect(maxActiveDeliveries).toBe(1);

            releases.shift()?.();
            await expect.poll(() => startedUrls.length).toBe(2);
            expect(maxActiveDeliveries).toBe(1);
        } finally {
            for (const release of releases.splice(0)) release();
            await Promise.allSettled([flush1, flush2]);
            await outbox1.close();
            await outbox2.close();
        }
    });

    it('serializes same-session outbox handles through one owner so concurrent enqueues cannot overwrite the file', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const saves: Array<{
            mutationIds: string[];
            resolve: () => void;
        }> = [];
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                loadSessionMutationOutbox: vi.fn(async () => []),
                saveSessionMutationOutbox: vi.fn(async (_sessionId: string, mutations: readonly { mutationId?: unknown }[]) => {
                    if (saves.length >= 2) return;
                    const deferred = createDeferred<void>();
                    saves.push({
                        mutationIds: mutations.map((mutation) => String(mutation.mutationId ?? '')),
                        resolve: () => deferred.resolve(),
                    });
                    await deferred.promise;
                }),
                appendSessionMutationDeadLetters: vi.fn(async () => undefined),
            };
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const {
            createSessionEndMutation,
            createSessionTurnMutation,
        } = await import('./sessionMutationTypes');
        const socket = createApiSessionSocketStub({ connected: false });
        const firstHandle = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-shared-owner',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        const secondHandle = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-shared-owner',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        const first = firstHandle.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-shared-owner',
            action: 'begin',
            turnId: 'turn-1',
            mutationId: 'mutation-turn-begin',
            observedAt: 1_000,
        }));
        await expect.poll(() => saves.length, { timeout: 100 }).toBe(1);
        const second = secondHandle.enqueueSessionEnd(createSessionEndMutation({
            sessionId: 's-shared-owner',
            observedAt: 2_000,
        }));
        await Promise.resolve();
        await Promise.resolve();
        const saveCountBeforeFirstCompletes = saves.length;

        saves[0].resolve();
        await first;
        await expect.poll(() => saves.length, { timeout: 100 }).toBe(2);
        saves[1].resolve();
        await second;

        expect(saveCountBeforeFirstCompletes).toBe(1);
        expect(saves[1].mutationIds).toEqual(expect.arrayContaining([
            'mutation-turn-begin',
            expect.stringMatching(/^[0-9a-f-]{36}$/i),
        ]));
        await firstHandle.close();
        await secondHandle.close();
    });
});
