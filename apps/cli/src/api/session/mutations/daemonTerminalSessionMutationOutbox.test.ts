import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let tempHome: string | null = null;
const originalHome = process.env.HAPPIER_HOME_DIR;

afterEach(async () => {
    process.env.HAPPIER_HOME_DIR = originalHome;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
    vi.resetModules();
});

describe('daemon terminal session mutation outbox', () => {
    it('exposes only exact-turn enqueue, flush, and close', async () => {
        tempHome = await mkdtemp(join(tmpdir(), 'daemon-terminal-outbox-'));
        process.env.HAPPIER_HOME_DIR = tempHome;
        vi.resetModules();
        const { createDaemonTerminalSessionMutationOutbox } = await import('./daemonTerminalSessionMutationOutbox');
        const mutation = { v: 1 as const, sessionId: 's1', mutationId: 'm1', action: 'end_session' as const, turnId: 't1', observedAt: 1 };
        const outbox = createDaemonTerminalSessionMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: true, emit: () => undefined, emitWithAck: async () => ({ ...mutation, decision: 'applied', appliedAt: 2 }) }),
            requestReconnect: () => {},
        });
        expect(Object.keys(outbox).sort()).toEqual(['close', 'enqueueExactTurnEnd', 'flush']);
        await outbox.enqueueExactTurnEnd(mutation);
        await outbox.close();
    });

    it('rejects exact-turn admission after close instead of reporting volatile success', async () => {
        tempHome = await mkdtemp(join(tmpdir(), 'daemon-terminal-outbox-closed-'));
        process.env.HAPPIER_HOME_DIR = tempHome;
        vi.resetModules();
        const { createDaemonTerminalSessionMutationOutbox } = await import('./daemonTerminalSessionMutationOutbox');
        const mutation = { v: 1 as const, sessionId: 's1', mutationId: 'm1', action: 'end_session' as const, turnId: 't1', observedAt: 1 };
        const outbox = createDaemonTerminalSessionMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined, emitWithAck: async () => ({ ok: false }) }),
            requestReconnect: () => {},
        });

        await outbox.close();

        await expect(outbox.enqueueExactTurnEnd(mutation)).rejects.toThrow('not durably persisted');
    });

    it('rejects joining one queue path with different custody facts', async () => {
        tempHome = await mkdtemp(join(tmpdir(), 'daemon-terminal-outbox-facts-'));
        const { createSessionMutationJournal } = await import('./createSessionMutationOutbox');
        const { parseQueuedSessionMutation } = await import('./sessionMutationPersistence');
        const paths = { queuePath: join(tempHome, 'shared.json'), deadLetterPath: join(tempHome, 'shared.dead-letter.json') };
        const boundary = { connected: false, emit: () => undefined, emitWithAck: async () => ({ ok: false }) };
        const first = createSessionMutationJournal({
            custody: 'runtime', sessionId: 's1', paths, admission: parseQueuedSessionMutation,
            token: 'token', getSocket: () => boundary, requestReconnect: () => {},
        });
        expect(() => createSessionMutationJournal({
            custody: 'daemon-terminal', sessionId: 's2', paths, admission: parseQueuedSessionMutation,
            token: 'token', getSocket: () => boundary, requestReconnect: () => {},
        })).toThrow('different custody facts');
        await first.close();
    });

    it('preserves the first exact observed facts when marker retry reuses the deterministic identity', async () => {
        tempHome = await mkdtemp(join(tmpdir(), 'daemon-terminal-outbox-retry-'));
        process.env.HAPPIER_HOME_DIR = tempHome;
        vi.resetModules();
        const { createDaemonTerminalSessionMutationOutbox } = await import('./daemonTerminalSessionMutationOutbox');
        const { configuration } = await import('@/configuration');
        const { resolveSessionMutationJournalPaths } = await import('./sessionMutationPersistence');
        const boundary = { connected: false, emit: () => undefined, emitWithAck: async () => ({ ok: false }) };
        const createOutbox = () => createDaemonTerminalSessionMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => boundary,
            requestReconnect: () => {},
        });

        const first = createOutbox();
        await first.enqueueExactTurnEnd({
            v: 1, sessionId: 's1', mutationId: 'daemon-observed-exit:stable',
            action: 'end_session', turnId: 't1', observedAt: 100,
        });
        await first.close();

        const retry = createOutbox();
        await retry.enqueueExactTurnEnd({
            v: 1, sessionId: 's1', mutationId: 'daemon-observed-exit:stable',
            action: 'end_session', turnId: 't1', observedAt: 200,
        });
        await retry.close();

        const paths = resolveSessionMutationJournalPaths({
            activeServerDir: configuration.activeServerDir,
            sessionId: 's1',
            custody: 'daemon-terminal',
        });
        const persisted = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ payload: { observedAt: number } }>;
        };
        expect(persisted.mutations).toHaveLength(1);
        expect(persisted.mutations[0]?.payload.observedAt).toBe(100);
    });
});
