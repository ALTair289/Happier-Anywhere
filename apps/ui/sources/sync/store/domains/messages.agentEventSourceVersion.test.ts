import { beforeEach, describe, expect, it } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createMessagesDomain } from './messages';

function createHarness(initial: any = {}) {
    let state: any = {
        sessions: {
            s1: {
                id: 's1',
                createdAt: 1,
                active: true,
                activeAt: 1,
                metadataVersion: 1,
                metadata: null,
                permissionMode: null,
                permissionModeUpdatedAt: 0,
            },
        },
        sessionListRenderables: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        machines: {},
        machineDisplayById: {},
        settings: {},
        sessionPending: {},
        sessionMessages: {},
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

function buildTextMessage(id: string, seq: number, text: string) {
    return {
        id,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        isSidechain: false,
        role: 'agent',
        content: [{ type: 'text', text, uuid: `u-${id}`, parentUUID: null }],
    } as any;
}

function buildAccountSwitchEventMessage(id: string, seq: number) {
    return {
        id,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        isSidechain: false,
        role: 'event',
        content: {
            type: 'connected-service-account-switch',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            fromProfileId: 'profile-a',
            toProfileId: 'profile-b',
            reason: 'usage_limit',
            mode: 'hot_apply',
        },
    } as any;
}

beforeEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('messages domain: agentEventSourceVersion', () => {
    it('stays stable across ordinary text appends', () => {
        const { get, domain } = createHarness();

        domain.applyMessages('s1', [buildTextMessage('m1', 1, 'hello')]);
        expect(get().sessionMessages.s1.agentEventSourceVersion).toBe(0);

        domain.applyMessages('s1', [buildTextMessage('m2', 2, 'world')]);
        expect(get().sessionMessages.s1.agentEventSourceVersion).toBe(0);
        expect(get().sessionMessages.s1.messagesVersion).toBe(2);
    });

    it('advances when an agent event enters the transcript and stays stable afterwards', () => {
        const { get, domain } = createHarness();

        domain.applyMessages('s1', [buildTextMessage('m1', 1, 'hello')]);
        domain.applyMessages('s1', [buildAccountSwitchEventMessage('evt-1', 2)]);

        const afterEvent = get().sessionMessages.s1;
        expect(afterEvent.agentEventSourceVersion).toBe(1);
        expect(
            Object.values(afterEvent.messagesById).some((m: any) => m.kind === 'agent-event'),
        ).toBe(true);

        domain.applyMessages('s1', [buildTextMessage('m3', 3, 'after event')]);
        expect(get().sessionMessages.s1.agentEventSourceVersion).toBe(1);
    });

    it('resets transcript state without leaving a reusable stale agent-event version', () => {
        const { get, domain } = createHarness();

        domain.applyMessages('s1', [buildAccountSwitchEventMessage('evt-1', 1)]);
        expect(get().sessionMessages.s1.agentEventSourceVersion).toBe(1);

        domain.resetSessionMessages('s1');
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toEqual([]);
        expect(get().sessionMessages.s1.agentEventSourceVersion).toBe(0);
    });
});
