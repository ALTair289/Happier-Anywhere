import { describe, expect, it } from 'vitest';

import { buildSessionListIndexFromViewData, type SessionListIndexItem } from './sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListViewItem } from './sessionListViewData';
import { buildSessionListViewDataFromIndex } from './sessionListViewDataFromIndex';

function makeRenderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
    };
}

function makeSource(): SessionListViewItem[] {
    return [
        {
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            groupKey: 'server:server-a:day:2026-05-04',
            serverId: 'server-a',
        },
        {
            type: 'session',
            session: makeRenderable('a'),
            section: 'inactive',
            groupKey: 'server:server-a:day:2026-05-04',
            groupKind: 'date',
            serverId: 'server-a',
        },
        {
            type: 'session',
            session: makeRenderable('b'),
            section: 'inactive',
            groupKey: 'server:server-a:day:2026-05-04',
            groupKind: 'date',
            serverId: 'server-a',
        },
    ];
}

describe('buildSessionListViewDataFromIndex', () => {
    it('preserves the source view-data reference when the computed index is unchanged', () => {
        const source = makeSource();
        const sourceIndex = buildSessionListIndexFromViewData(source);

        const result = buildSessionListViewDataFromIndex({
            index: sourceIndex,
            source,
            sourceIndex,
        });

        expect(result).toBe(source);
    });

    it('reuses source session rows when the index only normalizes omitted keep-visible flags to false', () => {
        const source = makeSource();
        const sessionItem = source[1];
        expect(sessionItem?.type).toBe('session');
        if (sessionItem?.type !== 'session') return;
        const sessionWithoutFalseFlag = {
            ...sessionItem,
            session: {
                ...sessionItem.session,
                keepVisibleWhenInactive: undefined,
            },
        };
        const normalizedSource = [
            source[0]!,
            sessionWithoutFalseFlag,
            source[2]!,
        ];
        const sourceIndex = buildSessionListIndexFromViewData(normalizedSource);
        expect(sourceIndex).not.toBeNull();
        const typedSourceIndex = sourceIndex as SessionListIndexItem[];
        const computedIndex: SessionListIndexItem[] = typedSourceIndex.map((item) => ({ ...item }));

        const result = buildSessionListViewDataFromIndex({
            index: computedIndex,
            source: normalizedSource,
            sourceIndex: typedSourceIndex,
        });

        expect(result?.[1]).toBe(sessionWithoutFalseFlag);
        expect(result?.[1]?.type === 'session' ? result[1].session : null).toBe(sessionWithoutFalseFlag.session);
    });

    it('rehydrates synthetic headers and projected session fields from a computed index', () => {
        const source = makeSource();
        const sourceIndex = buildSessionListIndexFromViewData(source);
        expect(sourceIndex).not.toBeNull();
        const typedSourceIndex = sourceIndex as SessionListIndexItem[];
        const pinnedSession = typedSourceIndex[2] as Extract<SessionListIndexItem, { type: 'session' }>;
        const computedIndex: SessionListIndexItem[] = [
            { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: 'pinned-v1' },
            {
                ...pinnedSession,
                pinned: true,
                groupKey: 'pinned-v1',
                groupKind: 'pinned',
                variant: 'default',
            },
            typedSourceIndex[0]!,
            typedSourceIndex[1]!,
        ];

        const result = buildSessionListViewDataFromIndex({
            index: computedIndex,
            source,
            sourceIndex: typedSourceIndex,
        });

        expect(result?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}:${item.title}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.pinned === true ? 'pinned' : 'unpinned'}`
        )).toEqual([
            'header:pinned:Pinned',
            'session:b:pinned:pinned',
            'header:date:Today',
            'session:a:date:unpinned',
        ]);
        expect(result?.[2]).toBe(source[0]);
        expect(result?.[3]).toBe(source[1]);
    });
});
