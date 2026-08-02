import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { getStorage, storage } from '@/sync/domains/state/storageStore';

import { useSessionListSearchTextByKey } from './useSessionListSearchTextByKey';

function sessionItem(sessionId: string): SessionListViewItem {
    return {
        type: 'session',
        serverId: 'server1',
        session: buildSessionListRenderableFromSession(createSessionFixture({ id: sessionId })),
    };
}

function bumpDelta(revision: number): void {
    storage.setState((state) => ({
        ...state,
        sessionListRenderableDelta: {
            revision,
            changedSessionIds: ['s1'],
            removedSessionIds: [],
            rebuiltSessionListViewData: false,
        },
    }));
}

describe('useSessionListSearchTextByKey subscription width', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not re-render when only the session-list change envelope ticks', async () => {
        const items = [sessionItem('s1'), sessionItem('s2')];

        let renders = 0;
        let controlRenders = 0;
        await renderHook(() => {
            renders += 1;
            return useSessionListSearchTextByKey(items, false);
        });
        // Control: a subscriber that reads the change envelope directly. Without it, a passing
        // assertion above proves nothing — it could just mean the harness cannot see a re-render.
        await renderHook(() => {
            controlRenders += 1;
            return getStorage()((state) => state.sessionListRenderableDelta);
        });

        const rendersBefore = renders;
        const controlBefore = controlRenders;

        await act(async () => {
            bumpDelta(1_001);
        });
        await act(async () => {
            bumpDelta(1_002);
        });

        expect(controlRenders).toBe(controlBefore + 2);
        expect(renders).toBe(rendersBefore);
    });

    it('still indexes searchable text once search is enabled', async () => {
        const items = [sessionItem('s1')];
        const hook = await renderHook(
            (enabled: boolean) => useSessionListSearchTextByKey(items, enabled),
            { initialProps: false },
        );

        expect(hook.getCurrent()).toEqual({});

        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                s1: {
                    messageIdsOldestFirst: ['m1'],
                    messagesById: {
                        m1: {
                            kind: 'agent-text',
                            id: 'm1',
                            localId: null,
                            seq: 1,
                            createdAt: 1,
                            text: 'indexable transcript body',
                        },
                    },
                },
            },
        } as never));

        const enabled = await hook.rerender(true);
        expect(Object.values(enabled)).toEqual(['indexable transcript body']);
    });
});
