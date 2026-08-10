import { beforeEach, describe, expect, it } from 'vitest';

import { normalizeDirectTranscriptMessages } from '@/sync/runtime/directSessions/normalizeDirectTranscriptMessages';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { createMessagesDomain } from './messages';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        machines: {},
        machineDisplayById: {},
        settings: {},
        sessionPending: {},
        sessionMessages: {},
    };
    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };
    return { get, domain: createMessagesDomain({ get, set } as any) };
}

function directUser(localId: string, id: string, text = 'same prompt'): NormalizedMessage {
    const [message] = normalizeDirectTranscriptMessages([{
        id,
        localId,
        createdAtMs: 100,
        raw: { role: 'user', content: { type: 'text', text } },
    }]);
    if (!message) throw new Error('expected Direct user message to normalize');
    return message;
}

function committedUser(localId: string, id: string, seq: number, text = 'same prompt'): NormalizedMessage {
    return {
        id,
        seq,
        localId,
        createdAt: 200,
        role: 'user',
        content: { type: 'text', text },
        isSidechain: false,
    };
}

function userRows(state: any) {
    const entry = state.sessionMessages.s1;
    return (entry?.messageIdsOldestFirst ?? [])
        .map((id: string) => entry.messagesById[id])
        .filter((message: any) => message?.kind === 'user-text');
}

beforeEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('messages domain: Direct user echo reconciliation', () => {
    it.each([
        ['server first', ['server', 'direct']],
        ['Direct first', ['direct', 'server']],
    ] as const)('keeps the canonical committed row when %s', (_label, order) => {
        const { get, domain } = createHarness();
        const direct = directUser('client-local-1', 'codex-offset-1');
        const server = committedUser('client-local-1', 'server-7', 7);

        for (const source of order) {
            domain.applyMessages('s1', [source === 'server' ? server : direct]);
        }

        expect(userRows(get())).toEqual([
            expect.objectContaining({
                localId: 'client-local-1',
                realID: 'server-7',
                seq: 7,
                text: 'same prompt',
            }),
        ]);
    });

    it('keeps two real identical sends with distinct client ids', () => {
        const { get, domain } = createHarness();
        domain.applyMessages('s1', [
            directUser('client-local-1', 'codex-offset-1'),
            directUser('client-local-2', 'codex-offset-2'),
        ]);
        domain.applyMessages('s1', [
            committedUser('client-local-1', 'server-7', 7),
            committedUser('client-local-2', 'server-9', 9),
        ]);

        expect(userRows(get()).map((message: any) => ({
            localId: message.localId,
            realID: message.realID,
            seq: message.seq,
            text: message.text,
        }))).toEqual([
            { localId: 'client-local-1', realID: 'server-7', seq: 7, text: 'same prompt' },
            { localId: 'client-local-2', realID: 'server-9', seq: 9, text: 'same prompt' },
        ]);
    });

    it('reconciles an opaque client id without normalizing it', () => {
        const { get, domain } = createHarness();
        const localId = '  exact-id  ';

        domain.applyMessages('s1', [directUser(localId, 'codex-offset-1')]);
        domain.applyMessages('s1', [committedUser(localId, 'server-7', 7)]);

        expect(userRows(get())).toEqual([
            expect.objectContaining({
                localId,
                realID: 'server-7',
                seq: 7,
            }),
        ]);
    });

    it.each([
        ['server then Direct', ['server', 'direct']],
        ['Direct then server', ['direct', 'server']],
    ] as const)('reconciles an exact pair in one atomic store publish when ordered %s', (_label, order) => {
        const { get, domain } = createHarness();
        const direct = directUser('client-local-1', 'codex-offset-1');
        const server = committedUser('client-local-1', 'server-7', 7);

        domain.applyMessages('s1', order.map((source) => source === 'server' ? server : direct));

        expect(userRows(get())).toEqual([
            expect.objectContaining({
                localId: 'client-local-1',
                realID: 'server-7',
                seq: 7,
            }),
        ]);
    });

    it('does not resurrect a Direct echo when its delta is replayed after commit', () => {
        const { get, domain } = createHarness();
        const direct = directUser('client-local-1', 'codex-offset-1');

        domain.applyMessages('s1', [direct]);
        domain.applyMessages('s1', [committedUser('client-local-1', 'server-7', 7)]);
        domain.applyMessages('s1', [direct]);

        expect(userRows(get())).toEqual([
            expect.objectContaining({
                localId: 'client-local-1',
                realID: 'server-7',
                seq: 7,
            }),
        ]);
    });

    it.each([
        ['recovered server first', ['server', 'direct']],
        ['Direct first', ['direct', 'server']],
    ] as const)('keeps the canonical recovered-history row when %s', (_label, order) => {
        const { get, domain } = createHarness();
        const direct = directUser('client-local-1', 'codex-offset-1');
        const server = {
            ...committedUser('client-local-1', 'server-7', 7),
            transcriptObservationProvenance: { kind: 'non_dependent' as const, source: 'history' as const },
        };

        for (const source of order) {
            domain.applyMessages('s1', [source === 'server' ? server : direct]);
        }

        expect(userRows(get())).toEqual([
            expect.objectContaining({
                localId: 'client-local-1',
                realID: 'server-7',
                seq: 7,
            }),
        ]);
    });

    it('keeps native Direct input that has no matching Happier client id', () => {
        const { get, domain } = createHarness();
        domain.applyMessages('s1', [directUser('codex-offset-native', 'codex-offset-native', 'typed in Codex')]);

        expect(userRows(get())).toEqual([
            expect.objectContaining({
                localId: 'codex-offset-native',
                realID: 'codex-offset-native',
                text: 'typed in Codex',
            }),
        ]);
    });

    it('keeps an external Codex client id when no canonical Happier row exists', () => {
        const { get, domain } = createHarness();
        domain.applyMessages('s1', [directUser('external-codex-client-id', 'codex-offset-external', 'external input')]);

        expect(userRows(get())).toEqual([
            expect.objectContaining({
                localId: 'external-codex-client-id',
                realID: 'codex-offset-external',
                text: 'external input',
            }),
        ]);
    });
});
