import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string | null = null;

function createStorageExhaustedError(): NodeJS.ErrnoException {
    const error = new Error('journal storage exhausted') as NodeJS.ErrnoException;
    error.code = 'ENOSPC';
    return error;
}

function createObservationSocket() {
    const emitWithAck = vi.fn<(event: string, ...args: unknown[]) => Promise<unknown>>(
        async (event: string): Promise<unknown> => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                return { ok: false, error: 'internal' };
            }
            return { ok: false, error: 'unsupported' };
        },
    );
    const socket = {
        connected: true,
        emit: vi.fn(),
        emitWithAck,
        timeout() {
            return socket;
        },
    };
    return socket;
}

async function createJournal(sessionId: string, socket: ReturnType<typeof createObservationSocket>) {
    const {
        createSessionMutationPersistenceContext,
        parseQueuedSessionMutation,
    } = await import('./sessionMutationPersistence');
    const { createSessionMutationJournal } = await import('./createSessionMutationOutbox');
    const context = createSessionMutationPersistenceContext({
        activeServerDir: tempDir!,
        custody: 'runtime',
        sessionId,
        parseQueuedMutation: parseQueuedSessionMutation,
    });
    return {
        context,
        journal: createSessionMutationJournal({
            custody: 'runtime',
            sessionId,
            paths: context.paths,
            admission: parseQueuedSessionMutation,
            token: 'token',
            getSocket: () => socket,
            requestReconnect: () => {},
        }),
    };
}

async function readPersistedMutations(queuePath: string): Promise<unknown[]> {
    try {
        const parsed = JSON.parse(await readFile(queuePath, 'utf8')) as { mutations?: unknown[] };
        return Array.isArray(parsed.mutations) ? parsed.mutations : [];
    } catch {
        return [];
    }
}

describe('session mutation journal resource safety', () => {
    beforeEach(async () => {
        vi.resetModules();
        tempDir = await mkdtemp(join(tmpdir(), 'happier-session-mutation-resource-'));
    });

    afterEach(async () => {
        vi.doUnmock('@/utils/fs/writeJsonAtomic');
        vi.resetModules();
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
            tempDir = null;
        }
    });

    it('reports typed admission backpressure before provider dispatch when durable headroom is unavailable', async () => {
        vi.doMock('@/utils/fs/writeJsonAtomic', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/utils/fs/writeJsonAtomic')>();
            return {
                ...actual,
                writeJsonAtomic: vi.fn(async () => {
                    throw createStorageExhaustedError();
                }),
            };
        });
        const socket = createObservationSocket();
        const { journal } = await createJournal('pre-dispatch-capacity', socket);
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');

        let failure: unknown;
        try {
            await journal.awaitReady();
            failure = await journal.enqueueSessionTurnDurably(createSessionTurnMutation({
                sessionId: 'pre-dispatch-capacity',
                mutationId: 'turn-begin-capacity',
                action: 'begin',
                turnId: 'turn-1',
                observedAt: 1,
            })).then(() => null, (error: unknown) => error);
        } finally {
            await journal.close().catch(() => undefined);
        }

        expect(socket.emitWithAck).not.toHaveBeenCalled();
        expect(failure).toMatchObject({
            name: 'SessionMutationJournalAdmissionBlockedError',
            cause: expect.objectContaining({ code: 'ENOSPC' }),
        });
    });

    it('persists retained transcript output before recovery delivery and durably removes it afterward', async () => {
        let rejectedWritesRemaining = 2;
        const observedOrder: string[] = [];
        vi.doMock('@/utils/fs/writeJsonAtomic', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/utils/fs/writeJsonAtomic')>();
            return {
                ...actual,
                writeJsonAtomic: vi.fn(async (path: string, value: unknown) => {
                    const mutationCount = typeof value === 'object'
                        && value !== null
                        && 'mutations' in value
                        && Array.isArray(value.mutations)
                        ? value.mutations.length
                        : -1;
                    if (rejectedWritesRemaining > 0) {
                        rejectedWritesRemaining -= 1;
                        observedOrder.push(`persist-rejected:${mutationCount}`);
                        throw createStorageExhaustedError();
                    }
                    observedOrder.push(`persisted:${mutationCount}`);
                    await actual.writeJsonAtomic(path, value);
                }),
            };
        });
        const socket = createObservationSocket();
        socket.emitWithAck.mockImplementation(async (event: string) => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                observedOrder.push('delivered');
                return {
                    ok: true,
                    status: 'observed',
                    id: 'message-id',
                    seq: 1,
                    localId: 'already-emitted-output',
                    didWrite: true,
                    ingestedAt: 2,
                };
            }
            return { ok: false, error: 'unsupported' };
        });
        const { context, journal } = await createJournal('active-output-capacity', socket);
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const mutation = createTranscriptMessageAppendMutation({
            sessionId: 'active-output-capacity',
            localId: 'already-emitted-output',
            content: 'provider output already observed',
            createdAt: 1,
            updatedAt: 1,
            provenance: { kind: 'non_dependent', source: 'external' },
        });

        try {
            await journal.awaitReady();
            await journal.flush('flush');
            await journal.enqueueTranscriptMessage(mutation).catch(() => undefined);
            await expect(journal.flush('flush')).rejects.toMatchObject({ code: 'ENOSPC' });
            expect(socket.emitWithAck).not.toHaveBeenCalled();
            await journal.flush('flush');
            await journal.flush('flush');

            expect(observedOrder).toEqual([
                'persist-rejected:1',
                'persist-rejected:1',
                'persisted:1',
                'delivered',
            ]);
            expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
            await expect(readPersistedMutations(context.paths.queuePath)).resolves.toEqual([]);
        } finally {
            await journal.close().catch(() => undefined);
        }
    });
});
