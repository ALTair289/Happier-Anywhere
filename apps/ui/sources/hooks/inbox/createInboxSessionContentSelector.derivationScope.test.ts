import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';
import { createReducer } from '@/sync/reducer/reducer';

import { createInboxSessionContentSelector } from './createInboxSessionContentSelector';

const SESSION_COUNT = 40;

/**
 * `thinkingAt` is read for every session by the runtime-freshness derivation,
 * so counting reads of it measures how many sessions the selector actually
 * re-derives on a wave. A wave that moved one session must not pay for the
 * whole account.
 */
function createTrackedSession(id: string, onFieldRead: (id: string) => void): Session {
    const session = {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        thinking: false,
        presence: 'online',
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
    } as unknown as Session;
    Object.defineProperty(session, 'thinkingAt', {
        configurable: true,
        enumerable: true,
        get: () => {
            onFieldRead(id);
            return 0;
        },
    });
    return session;
}

function createUnreadRenderable(id: string, hasUnreadMessages: boolean): SessionListRenderableSession {
    return {
        id,
        seq: 2,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        lastViewedSessionSeq: hasUnreadMessages ? 1 : 2,
        hasUnreadMessages,
    } as unknown as SessionListRenderableSession;
}

function createSessionMessages(messagesVersion: number): SessionMessages {
    return {
        messageIdsOldestFirst: [],
        messagesById: {},
        messagesMap: {},
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion,
        isLoaded: true,
    };
}

function createState(params: Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderables?: Record<string, SessionListRenderableSession>;
    sessionMessages?: Record<string, SessionMessages>;
    delta: StorageState['sessionListRenderableDelta'];
}>): StorageState {
    return {
        sessions: params.sessions,
        sessionListRenderables: params.sessionListRenderables ?? {},
        sessionMessages: params.sessionMessages ?? {},
        sessionListRenderableDelta: params.delta,
    } as unknown as StorageState;
}

function buildTrackedSessions(onFieldRead: (id: string) => void): Record<string, Session> {
    const sessions: Record<string, Session> = {};
    for (let index = 0; index < SESSION_COUNT; index += 1) {
        const id = `row-${index}`;
        sessions[id] = createTrackedSession(id, onFieldRead);
    }
    return sessions;
}

describe('createInboxSessionContentSelector derivation scope', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('costs nothing when a store notification moved none of its inputs', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
        const reads: string[] = [];
        const sessions = buildTrackedSessions((id) => reads.push(id));
        const renderables = { unread: createUnreadRenderable('unread', true) };
        const sessionMessages = { 'row-0': createSessionMessages(1) };
        const selector = createInboxSessionContentSelector();
        const delta = {
            revision: 1,
            changedSessionIds: Object.keys(sessions),
            removedSessionIds: [],
            rebuiltSessionListViewData: true,
        } as const;

        expect(selector(createState({
            sessions,
            sessionListRenderables: renderables,
            sessionMessages,
            delta,
        }))).toBe(true);
        expect(reads.length).toBeGreaterThan(0);

        // Same records, same delta: another store domain notified.
        reads.length = 0;
        expect(selector(createState({
            sessions,
            sessionListRenderables: renderables,
            sessionMessages,
            delta,
        }))).toBe(true);

        expect(reads).toEqual([]);
    });

    it('does not re-derive every session when one unrelated transcript advances', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
        const reads: string[] = [];
        const sessions = buildTrackedSessions((id) => reads.push(id));
        const renderables = { unread: createUnreadRenderable('unread', true) };
        const selector = createInboxSessionContentSelector();
        const delta = {
            revision: 1,
            changedSessionIds: Object.keys(sessions),
            removedSessionIds: [],
            rebuiltSessionListViewData: true,
        } as const;

        expect(selector(createState({
            sessions,
            sessionListRenderables: renderables,
            sessionMessages: { 'row-0': createSessionMessages(1) },
            delta,
        }))).toBe(true);

        reads.length = 0;
        expect(selector(createState({
            sessions,
            sessionListRenderables: renderables,
            sessionMessages: { 'row-0': createSessionMessages(2) },
            delta,
        }))).toBe(true);

        expect(reads.filter((id) => id !== 'row-0')).toEqual([]);
    });

    it('does not re-derive every session when one unrelated session changes while content is present', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
        const reads: string[] = [];
        const sessions = buildTrackedSessions((id) => reads.push(id));
        const renderables = { unread: createUnreadRenderable('unread', true) };
        const selector = createInboxSessionContentSelector();

        expect(selector(createState({
            sessions,
            sessionListRenderables: renderables,
            delta: {
                revision: 1,
                changedSessionIds: [...Object.keys(sessions), 'unread'],
                removedSessionIds: [],
                rebuiltSessionListViewData: true,
            },
        }))).toBe(true);

        // `row-9` has no inbox content of its own, so the delta wave cannot
        // answer `true` from the changed row alone — but it must not rescan.
        reads.length = 0;
        const nextSessions = { ...sessions, 'row-9': createTrackedSession('row-9', (id) => reads.push(id)) };
        expect(selector(createState({
            sessions: nextSessions,
            sessionListRenderables: renderables,
            delta: {
                revision: 2,
                changedSessionIds: ['row-9'],
                removedSessionIds: [],
                rebuiltSessionListViewData: false,
            },
        }))).toBe(true);

        expect(reads.filter((id) => id !== 'row-9')).toEqual([]);
    });

    it('drops to false when the only session with content is read', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
        const sessions = buildTrackedSessions(() => {});
        const selector = createInboxSessionContentSelector();

        expect(selector(createState({
            sessions,
            sessionListRenderables: { unread: createUnreadRenderable('unread', true) },
            delta: {
                revision: 1,
                changedSessionIds: [...Object.keys(sessions), 'unread'],
                removedSessionIds: [],
                rebuiltSessionListViewData: true,
            },
        }))).toBe(true);

        expect(selector(createState({
            sessions,
            sessionListRenderables: { unread: createUnreadRenderable('unread', false) },
            delta: {
                revision: 2,
                changedSessionIds: ['unread'],
                removedSessionIds: [],
                rebuiltSessionListViewData: false,
            },
        }))).toBe(false);
    });

    it('drops to false when the only session with content is removed', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
        const sessions = buildTrackedSessions(() => {});
        const selector = createInboxSessionContentSelector();

        expect(selector(createState({
            sessions,
            sessionListRenderables: { unread: createUnreadRenderable('unread', true) },
            delta: {
                revision: 1,
                changedSessionIds: [...Object.keys(sessions), 'unread'],
                removedSessionIds: [],
                rebuiltSessionListViewData: true,
            },
        }))).toBe(true);

        expect(selector(createState({
            sessions,
            sessionListRenderables: {},
            delta: {
                revision: 2,
                changedSessionIds: [],
                removedSessionIds: ['unread'],
                rebuiltSessionListViewData: false,
            },
        }))).toBe(false);
    });
});
