import { describe, expect, it } from 'vitest';

import type { StorageState } from '@/sync/store/types';

import {
    createSessionListSearchTextSelector,
    type SessionSearchKey,
} from './useSessionListSearchTextByKey';
import { sessionTagKey } from './sessionTagUtils';

const SERVER_ID = 'server1';

function searchKey(sessionId: string): SessionSearchKey {
    return { serverId: SERVER_ID, sessionId, key: sessionTagKey(SERVER_ID, sessionId) };
}

function agentTextMessage(id: string, text: string) {
    return {
        kind: 'agent-text' as const,
        id,
        localId: null,
        seq: 1,
        createdAt: 1,
        text,
    };
}

function committedMessages(sessionId: string, text: string) {
    return {
        [sessionId]: {
            messageIdsOldestFirst: [`${sessionId}-m1`],
            messagesById: { [`${sessionId}-m1`]: agentTextMessage(`${sessionId}-m1`, text) },
        },
    };
}

function buildState(input: Readonly<{
    revision: number;
    changedSessionIds?: readonly string[];
    removedSessionIds?: readonly string[];
    rebuiltSessionListViewData?: boolean;
    sessionMessages?: Record<string, unknown>;
    sessionPending?: Record<string, unknown>;
}>): StorageState {
    return {
        sessionMessages: input.sessionMessages ?? {},
        sessionPending: input.sessionPending ?? {},
        sessionListRenderableDelta: {
            revision: input.revision,
            changedSessionIds: input.changedSessionIds ?? [],
            removedSessionIds: input.removedSessionIds ?? [],
            rebuiltSessionListViewData: input.rebuiltSessionListViewData ?? false,
        },
    } as unknown as StorageState;
}

describe('createSessionListSearchTextSelector', () => {
    it('builds the full index on first evaluation (full-rebuild fallback)', () => {
        const selector = createSessionListSearchTextSelector([searchKey('s1'), searchKey('s2')]);
        const result = selector(buildState({
            revision: 1,
            rebuiltSessionListViewData: true,
            sessionMessages: {
                ...committedMessages('s1', 'hello world'),
                ...committedMessages('s2', 'second session'),
            },
        }));

        expect(result).toEqual({
            [sessionTagKey(SERVER_ID, 's1')]: 'hello world',
            [sessionTagKey(SERVER_ID, 's2')]: 'second session',
        });
    });

    it('updates only the changed session on a delta tick and keeps the object stable when nothing changed', () => {
        const selector = createSessionListSearchTextSelector([searchKey('s1'), searchKey('s2')]);
        const first = selector(buildState({
            revision: 1,
            rebuiltSessionListViewData: true,
            sessionMessages: {
                ...committedMessages('s1', 'hello world'),
                ...committedMessages('s2', 'second session'),
            },
        }));

        // Delta names only s2 as changed; s1 text is untouched.
        const second = selector(buildState({
            revision: 2,
            changedSessionIds: ['s2'],
            sessionMessages: {
                ...committedMessages('s1', 'hello world'),
                ...committedMessages('s2', 'second session edited'),
            },
        }));

        expect(second).not.toBe(first);
        expect(second).toEqual({
            [sessionTagKey(SERVER_ID, 's1')]: 'hello world',
            [sessionTagKey(SERVER_ID, 's2')]: 'second session edited',
        });

        // A revision bump with no changed ids returns the identical memoized object.
        const third = selector(buildState({
            revision: 3,
            changedSessionIds: [],
            sessionMessages: {
                ...committedMessages('s1', 'hello world'),
                ...committedMessages('s2', 'second session edited'),
            },
        }));
        expect(third).toBe(second);
    });

    it('drops removed sessions from the index via the delta removed ids', () => {
        const selector = createSessionListSearchTextSelector([searchKey('s1'), searchKey('s2')]);
        selector(buildState({
            revision: 1,
            rebuiltSessionListViewData: true,
            sessionMessages: {
                ...committedMessages('s1', 'hello world'),
                ...committedMessages('s2', 'second session'),
            },
        }));

        const afterRemoval = selector(buildState({
            revision: 2,
            removedSessionIds: ['s1'],
            sessionMessages: {
                ...committedMessages('s2', 'second session'),
            },
        }));

        expect(afterRemoval).toEqual({
            [sessionTagKey(SERVER_ID, 's2')]: 'second session',
        });
        expect(Object.prototype.hasOwnProperty.call(afterRemoval, sessionTagKey(SERVER_ID, 's1'))).toBe(false);
    });

    it('falls back to a full rebuild when the view data was rebuilt', () => {
        const selector = createSessionListSearchTextSelector([searchKey('s1')]);
        selector(buildState({
            revision: 1,
            rebuiltSessionListViewData: true,
            sessionMessages: { ...committedMessages('s1', 'first') },
        }));

        // rebuiltSessionListViewData=true forces the full path even though the
        // delta names no changed ids: the fresh text must be picked up.
        const rebuilt = selector(buildState({
            revision: 2,
            changedSessionIds: [],
            rebuiltSessionListViewData: true,
            sessionMessages: { ...committedMessages('s1', 'rebuilt text') },
        }));

        expect(rebuilt).toEqual({
            [sessionTagKey(SERVER_ID, 's1')]: 'rebuilt text',
        });
    });
});
