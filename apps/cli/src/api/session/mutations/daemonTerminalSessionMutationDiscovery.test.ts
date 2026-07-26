import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExactSessionTurnEndMutationV1Schema } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createDaemonTerminalSessionMutationJournal } from './daemonTerminalSessionMutationOutbox';
import {
    discoverDaemonTerminalSessionMutationJournals,
    recoverDaemonTerminalSessionMutationJournals,
} from './daemonTerminalSessionMutationDiscovery';
import { createSessionMutationDeadLetterEntry } from './sessionMutationPersistence';

const tempDirs: string[] = [];

async function createTempActiveServerDir(): Promise<string> {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'daemon-terminal-discovery-'));
    tempDirs.push(activeServerDir);
    await mkdir(join(activeServerDir, 'session-mutations'), { recursive: true });
    return activeServerDir;
}

function exactQueuedMutation(sessionId: string, mutationId: string, turnId: string) {
    const payload = {
        v: 1 as const,
        sessionId,
        mutationId,
        action: 'end_session' as const,
        turnId,
        observedAt: 1,
    };
    return {
        kind: 'session_turn' as const,
        mutationId,
        payload,
        createdAt: 1,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('daemon terminal session mutation discovery', () => {
    it('rejects an explicit Adapter request whose paths are not the exact daemon-terminal pair', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const boundary = { connected: false, emit: () => undefined, emitWithAck: async () => ({ ok: false }) };

        expect(() => createDaemonTerminalSessionMutationJournal({
            token: 'token',
            sessionId: 's1',
            paths: {
                queuePath: join(activeServerDir, 'session-mutations', 'session-s1.json'),
                deadLetterPath: join(activeServerDir, 'session-mutations', 'session-s1.dead-letter.json'),
            },
            getSocket: () => boundary,
            requestReconnect: () => {},
        })).toThrow('exact daemon-terminal journal pair');
    });

    it('accepts only exact lossless daemon-terminal basenames and deduplicates each queue/dead-letter pair', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const mutationDir = join(activeServerDir, 'session-mutations');
        const accepted = [
            'session-alpha_1.daemon-terminal.json',
            'session-alpha_1.daemon-terminal.dead-letter.json',
            'session-dead-only.daemon-terminal.dead-letter.json',
        ];
        const rejected = [
            'session-runtime.json',
            'session-runtime.dead-letter.json',
            'session-a%2Fb.daemon-terminal.json',
            'session-..daemon-terminal.json',
            'session-alpha_1.daemon-terminal.json.tmp',
            '.tmp-12-34-abcd.json',
            'notes.json',
            'session-.daemon-terminal.json',
            'session-alpha_1.daemon-terminal.backup.json',
        ];
        await Promise.all([...accepted, ...rejected].map((name) => writeFile(join(mutationDir, name), '{}')));
        await mkdir(join(mutationDir, 'session-directory.daemon-terminal.json'));

        const result = await discoverDaemonTerminalSessionMutationJournals({ activeServerDir });

        expect(result.requests).toEqual([
            {
                custody: 'daemon-terminal',
                sessionId: 'alpha_1',
                paths: {
                    queuePath: join(mutationDir, 'session-alpha_1.daemon-terminal.json'),
                    deadLetterPath: join(mutationDir, 'session-alpha_1.daemon-terminal.dead-letter.json'),
                },
                discovered: ['queue', 'dead-letter'],
            },
            {
                custody: 'daemon-terminal',
                sessionId: 'dead-only',
                paths: {
                    queuePath: join(mutationDir, 'session-dead-only.daemon-terminal.json'),
                    deadLetterPath: join(mutationDir, 'session-dead-only.daemon-terminal.dead-letter.json'),
                },
                discovered: ['dead-letter'],
            },
        ]);
        expect(result.rejected.map(({ fileName, reason }) => ({ fileName, reason }))).toEqual(expect.arrayContaining([
            { fileName: 'session-runtime.json', reason: 'runtime-custody' },
            { fileName: 'session-runtime.dead-letter.json', reason: 'runtime-custody' },
            { fileName: 'session-a%2Fb.daemon-terminal.json', reason: 'traversal-like' },
            { fileName: 'session-..daemon-terminal.json', reason: 'traversal-like' },
            { fileName: 'session-alpha_1.daemon-terminal.json.tmp', reason: 'temporary' },
            { fileName: '.tmp-12-34-abcd.json', reason: 'temporary' },
            { fileName: 'notes.json', reason: 'unrelated' },
            { fileName: 'session-.daemon-terminal.json', reason: 'malformed-daemon-terminal-name' },
            { fileName: 'session-alpha_1.daemon-terminal.backup.json', reason: 'malformed-daemon-terminal-name' },
            { fileName: 'session-directory.daemon-terminal.json', reason: 'not-regular-file' },
        ]));
    });

    it('treats a missing mutation directory as an empty first startup', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'daemon-terminal-discovery-empty-'));
        tempDirs.push(activeServerDir);

        await expect(discoverDaemonTerminalSessionMutationJournals({ activeServerDir })).resolves.toEqual({
            requests: [],
            rejected: [],
        });
    });

    it('opens one strict daemon Adapter handle per session and hydrates queue plus dead-letter recovery without marker evidence', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const mutationDir = join(activeServerDir, 'session-mutations');
        const queueMutation = exactQueuedMutation('s1', 'queue-mutation', 'turn-queue');
        const recoveredMutation = exactQueuedMutation('s1', 'dead-mutation', 'turn-dead');
        const malformedMutation = {
            ...exactQueuedMutation('other-session', 'mismatch', 'turn-mismatch'),
            mutationId: 'mismatch',
        };
        await writeFile(join(mutationDir, 'session-s1.daemon-terminal.json'), JSON.stringify({
            v: 1,
            mutations: [queueMutation, malformedMutation],
        }));
        await writeFile(join(mutationDir, 'session-s1.daemon-terminal.dead-letter.json'), JSON.stringify({
            v: 1,
            entries: [createSessionMutationDeadLetterEntry({
                sessionId: 's1',
                mutation: recoveredMutation,
                reason: 'retryable_transport_failure',
            })],
        }));

        const delivered: string[] = [];
        const opened: string[] = [];
        const result = await recoverDaemonTerminalSessionMutationJournals({
            activeServerDir,
            openHandle: (request) => {
                opened.push(request.sessionId);
                return createDaemonTerminalSessionMutationJournal({
                    token: 'token',
                    sessionId: request.sessionId,
                    paths: request.paths,
                    getSocket: () => ({
                        connected: true,
                        emit: () => undefined,
                        emitWithAck: async (_event: string, ...args: unknown[]) => {
                            const mutation = ExactSessionTurnEndMutationV1Schema.parse(args[0]);
                            delivered.push(mutation.mutationId);
                            return { receipt: { ...mutation, decision: 'applied' as const, appliedAt: 2 } };
                        },
                    }),
                    requestReconnect: () => {},
                });
            },
        });

        expect(opened).toEqual(['s1']);
        expect(delivered.sort()).toEqual(['dead-mutation', 'queue-mutation']);
        expect(result.handles).toHaveLength(1);
        const deadLetters = JSON.parse(await readFile(join(mutationDir, 'session-s1.daemon-terminal.dead-letter.json'), 'utf8')) as {
            entries: Array<{ mutationId?: string; reason?: string; recoveryAttemptedAt?: number }>;
        };
        expect(deadLetters.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ mutationId: 'dead-mutation', recoveryAttemptedAt: expect.any(Number) }),
            expect.objectContaining({ mutationId: 'mismatch', reason: 'invalid_daemon_terminal_mutation' }),
        ]));
        await Promise.all(result.handles.map(({ handle }) => handle.close()));
    });

    it('restarts from a queue-only journal and retries it without a marker or a new exit', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const mutationDir = join(activeServerDir, 'session-mutations');
        const mutation = exactQueuedMutation('restart-session', 'restart-mutation', 'turn-restart');
        await writeFile(join(mutationDir, 'session-restart-session.daemon-terminal.json'), JSON.stringify({
            v: 1,
            mutations: [mutation],
        }));

        let connected = false;
        const delivered: string[] = [];
        const result = await recoverDaemonTerminalSessionMutationJournals({
            activeServerDir,
            openHandle: (request) => createDaemonTerminalSessionMutationJournal({
                token: 'token',
                sessionId: request.sessionId,
                paths: request.paths,
                getSocket: () => ({
                    connected,
                    emit: () => undefined,
                    emitWithAck: async (_event: string, ...args: unknown[]) => {
                        const payload = ExactSessionTurnEndMutationV1Schema.parse(args[0]);
                        delivered.push(payload.mutationId);
                        return { receipt: { ...payload, decision: 'applied' as const, appliedAt: 2 } };
                    },
                }),
                requestReconnect: () => {},
            }),
        });

        expect(delivered).toEqual([]);
        connected = true;
        await result.handles[0]?.handle.flush('connect');
        expect(delivered).toEqual(['restart-mutation']);
        await Promise.all(result.handles.map(({ handle }) => handle.close()));

        const restarted = await recoverDaemonTerminalSessionMutationJournals({
            activeServerDir,
            openHandle: (request) => createDaemonTerminalSessionMutationJournal({
                token: 'token',
                sessionId: request.sessionId,
                paths: request.paths,
                getSocket: () => ({ connected: true, emit: () => undefined, emitWithAck: async () => ({ ok: false }) }),
                requestReconnect: () => {},
            }),
        });
        expect(restarted.handles).toEqual([]);
    });
});
