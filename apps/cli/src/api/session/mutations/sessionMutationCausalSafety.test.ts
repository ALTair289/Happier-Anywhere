import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

import {
    createSessionMutationJournal,
    type SessionMutationJournal,
} from './createSessionMutationOutbox';
import { parseQueuedSessionMutation } from './sessionMutationPersistence';
import { createTranscriptMessageAppendMutation } from './sessionMutationTypes';
import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    type SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';

vi.mock('axios');

let tempDir: string | null = null;
let openJournals: SessionMutationJournal[] = [];
const originalMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;

async function createJournal(sessionId: string, options: Readonly<{
    observationResult?: 'observed' | 'retryable';
}> = {}) {
    if (!tempDir) throw new Error('test temp directory is unavailable');
    const socket = createApiSessionSocketStub({
        connected: options.observationResult !== undefined,
        emitWithAck: (event, payload) => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                if (options.observationResult === 'retryable') return { ok: false, error: 'internal' };
                const observation = payload as { localId?: unknown };
                return {
                    ok: true,
                    status: 'observed',
                    id: 'message-1',
                    seq: 1,
                    localId: observation.localId,
                    didWrite: true,
                    didUpdate: false,
                    ingestedAt: 2_000,
                };
            }
            return { ok: false, error: 'unsupported' };
        },
    });
    const queuePath = join(tempDir, `session-${sessionId}.json`);
    const deadLetterPath = join(tempDir, `session-${sessionId}.dead-letter.json`);
    const journal = createSessionMutationJournal({
        custody: 'runtime',
        sessionId,
        paths: { queuePath, deadLetterPath },
        admission: parseQueuedSessionMutation,
        token: 'token',
        getSocket: () => socket,
        requestReconnect: () => {},
    });
    openJournals.push(journal);
    return {
        queuePath,
        deadLetterPath,
        journal,
        socket,
    };
}

async function readArray(path: string, key: 'mutations' | 'entries'): Promise<unknown[]> {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        return Array.isArray(parsed[key]) ? parsed[key] : [];
    } catch {
        return [];
    }
}

async function seedLegacyTranscriptMutation(sessionId: string, mutation: ReturnType<typeof legacyAgentOutput>) {
    if (!tempDir) throw new Error('test temp directory is unavailable');
    const queuePath = join(tempDir, `session-${sessionId}.json`);
    await writeFile(queuePath, JSON.stringify({
        v: 1,
        mutations: [{
            kind: 'transcript_message_append',
            mutationId: mutation.mutationId,
            payload: mutation,
            intentOrder: 1,
            createdAt: mutation.createdAt,
            attempts: 0,
            nextAttemptAt: 0,
        }],
    }), 'utf8');
}

function agentOutput(
    sessionId: string,
    localId: string,
    provenance: SessionTranscriptObservationProvenanceV1,
) {
    return createTranscriptMessageAppendMutation({
        sessionId,
        localId,
        messageRole: 'agent',
        content: {
            t: 'plain',
            v: {
                role: 'agent',
                content: { type: 'text', text: `provider output ${localId}` },
            },
        },
        createdAt: 1_000,
        updatedAt: 1_000,
        provenance,
    });
}

function legacyAgentOutput(sessionId: string, localId: string) {
    return {
        v: 1 as const,
        sessionId,
        mutationId: `transcript:${sessionId}:${localId}`,
        source: 'transcript_message_append' as const,
        localId,
        messageRole: 'agent' as const,
        content: {
            t: 'plain' as const,
            v: {
                role: 'agent' as const,
                content: { type: 'text' as const, text: `provider output ${localId}` },
            },
        },
        createdAt: 1_000,
        updatedAt: 1_000,
    };
}

describe('session mutation causal safety V4 RED', () => {
    beforeEach(async () => {
        vi.mocked(axios.post).mockReset();
        tempDir = await mkdtemp(join(tmpdir(), 'happier-session-causal-outbox-red-'));
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '100';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    });

    afterEach(async () => {
        for (const journal of openJournals.splice(0)) {
            await journal.close().catch(() => {});
        }
        if (originalMaxAttempts === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = originalMaxAttempts;
        if (originalBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
        if (originalJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
        if (tempDir) await rm(tempDir, { recursive: true, force: true });
        tempDir = null;
    });

    it('rejects new transcript mutations that omit causal provenance', () => {
        expect(() => createTranscriptMessageAppendMutation({
            sessionId: 'missing-provenance',
            localId: 'assistant-new',
            messageRole: 'agent',
            content: {
                t: 'plain',
                v: {
                    role: 'agent',
                    content: { type: 'text', text: 'new output must be classified' },
                },
            },
            createdAt: 1_000,
            updatedAt: 1_000,
        } as Parameters<typeof createTranscriptMessageAppendMutation>[0])).toThrow(
            'Transcript append mutation provenance is required',
        );
    });

    it('rejects a direct live enqueue that bypasses the transcript mutation builder', async () => {
        const { journal, queuePath, socket } = await createJournal('direct-writer-bypass', {
            observationResult: 'observed',
        });

        await expect(journal.enqueueTranscriptMessage(
            legacyAgentOutput('direct-writer-bypass', 'assistant-1') as unknown as Parameters<
                SessionMutationJournal['enqueueTranscriptMessage']
            >[0],
        )).rejects.toThrow('Transcript append mutation provenance is required');

        expect(socket.emitWithAck).not.toHaveBeenCalledWith(
            SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            expect.anything(),
        );
        await expect(readArray(queuePath, 'mutations')).resolves.toEqual([]);
        await journal.close();
    });

    it('rejects a classified live mutation for a different outbox session before persistence', async () => {
        const { journal, queuePath, socket } = await createJournal('owning-session', {
            observationResult: 'observed',
        });

        await expect(journal.enqueueTranscriptMessage(agentOutput(
            'foreign-session',
            'assistant-cross-session',
            { kind: 'non_dependent', source: 'external' },
        ))).rejects.toThrow('Transcript append mutation sessionId must match outbox sessionId');

        expect(socket.emitWithAck).not.toHaveBeenCalledWith(
            SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            expect.anything(),
        );
        await expect(readArray(queuePath, 'mutations')).resolves.toEqual([]);
        await journal.close();
    });

    it('fails closed before transport when a recovered legacy mutation has neither Queue origin nor explicit non-dependent provenance', async () => {
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
        const legacyMutation = legacyAgentOutput('missing-provenance', 'assistant-1');
        await seedLegacyTranscriptMutation('missing-provenance', legacyMutation);
        const { journal, queuePath } = await createJournal('missing-provenance');
        await journal.awaitReady();
        await journal.flush('flush');

        expect(axios.post).not.toHaveBeenCalled();
        await expect(readArray(queuePath, 'mutations')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:missing-provenance:assistant-1',
            }),
        ]);
        await journal.close();
    });

    it('retains exact provider output content instead of reducing it to an unrecoverable summary after retry exhaustion', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 503 } });
        const { journal, queuePath, deadLetterPath } = await createJournal('no-silent-loss', {
            observationResult: 'retryable',
        });

        await journal.enqueueTranscriptMessage(
            agentOutput('no-silent-loss', 'assistant-1', { kind: 'non_dependent', source: 'external' }),
        );

        await expect(readArray(queuePath, 'mutations')).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'transcript:no-silent-loss:assistant-1',
                payload: expect.objectContaining({
                    content: expect.objectContaining({
                        v: expect.objectContaining({
                            content: expect.objectContaining({ text: 'provider output assistant-1' }),
                        }),
                    }),
                }),
            }),
        ]);
        await expect(readArray(deadLetterPath, 'entries')).resolves.toEqual([]);
        await journal.close();
    });

    it('forwards the stored source chronology instead of replacing it with later server-ingestion time', async () => {
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
        const { journal, socket } = await createJournal('source-chronology', { observationResult: 'observed' });
        const mutation = createTranscriptMessageAppendMutation({
            sessionId: 'source-chronology',
            localId: 'assistant-1',
            messageRole: 'agent',
            content: {
                t: 'plain',
                v: { role: 'agent', content: { type: 'text', text: 'historical output' } },
            },
            createdAt: 1_234,
            updatedAt: 1_567,
            provenance: { kind: 'non_dependent', source: 'history' },
        });

        await journal.enqueueTranscriptMessage(mutation);

        expect(socket.emitWithAck).toHaveBeenCalledWith(
            SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            expect.objectContaining({
                createdAt: 1_234,
                updatedAt: 1_567,
                provenance: { kind: 'non_dependent', source: 'history' },
            }),
        );
        expect(axios.post).not.toHaveBeenCalled();
        await journal.close();
    });

    it('preserves the fail-closed provenance decision across journal-owner restart', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('settlement unavailable'));
        await seedLegacyTranscriptMutation(
            'restart-correlation',
            legacyAgentOutput('restart-correlation', 'assistant-1'),
        );
        const first = await createJournal('restart-correlation');
        await first.journal.awaitReady();
        await first.journal.close();

        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
        const restarted = await createJournal('restart-correlation');
        // A caller-requested drain bypasses retry timing, so a pass here must come
        // from the durable causal decision rather than an incidental backoff delay.
        await restarted.journal.flush('flush');

        expect(axios.post).not.toHaveBeenCalled();
        await expect(readArray(restarted.queuePath, 'mutations')).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'transcript:restart-correlation:assistant-1',
            }),
        ]);
        await restarted.journal.close();
    });

    it('does not reclassify a provenance-free recovery row through same-localId coalescing', async () => {
        const sessionId = 'legacy-coalesce';
        const localId = 'assistant-1';
        await seedLegacyTranscriptMutation(sessionId, legacyAgentOutput(sessionId, localId));
        const { journal, queuePath, socket } = await createJournal(sessionId, {
            observationResult: 'observed',
        });
        await journal.awaitReady();
        await journal.flush('flush');

        await expect(journal.enqueueTranscriptMessage(agentOutput(
            sessionId,
            localId,
            { kind: 'non_dependent', source: 'history' },
        ))).rejects.toThrow('Cannot coalesce transcript snapshot across different causal provenance');

        expect(socket.emitWithAck).not.toHaveBeenCalledWith(
            SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            expect.anything(),
        );
        await expect(readArray(queuePath, 'mutations')).resolves.toEqual([
            expect.objectContaining({
                mutationId: `transcript:${sessionId}:${localId}`,
                payload: expect.not.objectContaining({ provenance: expect.anything() }),
            }),
        ]);
        await journal.close();
    });

    it('delivers independent output without a Pending dependency hold', async () => {
        const { journal, socket, queuePath } = await createJournal('independent-progress', {
            observationResult: 'observed',
        });

        await journal.enqueueTranscriptMessage(agentOutput(
            'independent-progress',
            'assistant-blocked',
            { kind: 'non_dependent', source: 'external' },
        ));
        await journal.enqueueTranscriptMessage(agentOutput(
            'independent-progress',
            'assistant-independent',
            { kind: 'non_dependent', source: 'external' },
        ));
        await journal.flush('flush');

        expect(socket.emitWithAck).toHaveBeenCalledWith(
            SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            expect.objectContaining({ localId: 'assistant-blocked' }),
        );
        expect(socket.emitWithAck).toHaveBeenCalledWith(
            SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            expect.objectContaining({ localId: 'assistant-independent' }),
        );
        await expect(readArray(queuePath, 'mutations')).resolves.toEqual([]);
        await journal.close();
    });
});
