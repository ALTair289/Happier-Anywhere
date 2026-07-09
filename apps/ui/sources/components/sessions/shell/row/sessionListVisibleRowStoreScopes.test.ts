import { describe, expect, it } from 'vitest';

import {
    buildSessionListEmbeddedPriorityRowKeys,
    buildSessionListRowStoreSubscriptionTelemetryFields,
    resolveSessionListRowStoreScopeKey,
    resolveSessionListRowStoreSubscriptionMode,
    resolveSessionListRowStoreSubscriptionScopes,
    reuseSessionListRowStoreKeySet,
    reuseSessionListRowStoreSubscriptionScopes,
    type SessionListRowStoreSubscriptionScope,
} from './sessionListVisibleRowStoreScopes';

describe('session list visible row store scopes', () => {
    it('keeps the full subscription set until viewability is known', () => {
        const scopes = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's2' },
        ];

        expect(resolveSessionListRowStoreSubscriptionScopes(scopes, null)).toBe(scopes);
    });

    it('keeps all rendered subscriptions when viewability is only an animation hint', () => {
        const scopes = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's2' },
            { serverId: 'server-a', sessionId: 's3' },
        ];

        expect(resolveSessionListRowStoreSubscriptionScopes(
            scopes,
            new Set(['server-a:s1']),
            'all-rendered',
        )).toBe(scopes);
    });

    it('selects all rendered row subscriptions for small non-virtualized web lists and bounded native lists', () => {
        expect(resolveSessionListRowStoreSubscriptionMode({
            platformOS: 'web',
            renderedSessionRows: 80,
            webNonVirtualizedMaxRows: 80,
        })).toBe('all-rendered');
        expect(resolveSessionListRowStoreSubscriptionMode({
            platformOS: 'web',
            renderedSessionRows: 81,
            webNonVirtualizedMaxRows: 80,
        })).toBe('viewable');
        expect(resolveSessionListRowStoreSubscriptionMode({
            platformOS: 'ios',
            renderedSessionRows: 10,
            nativeAllRenderedMaxRows: 200,
            webNonVirtualizedMaxRows: 80,
        })).toBe('all-rendered');
        expect(resolveSessionListRowStoreSubscriptionMode({
            platformOS: 'ios',
            renderedSessionRows: 201,
            nativeAllRenderedMaxRows: 200,
            webNonVirtualizedMaxRows: 80,
        })).toBe('viewable');
        expect(resolveSessionListRowStoreSubscriptionMode({
            platformOS: 'ios',
            renderedSessionRows: 10,
            webNonVirtualizedMaxRows: 80,
        })).toBe('viewable');
    });

    it('keeps priority rows subscribed even when viewability omits them', () => {
        const scopes = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's2' },
            { serverId: 'server-a', sessionId: 's3' },
        ];

        expect(resolveSessionListRowStoreSubscriptionScopes(
            scopes,
            new Set(['server-a:s1']),
            'viewable',
            new Set(['server-a:s3']),
        )).toEqual([
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's3' },
        ]);
    });

    it('does not eagerly subscribe every row in a large list before viewability is known', () => {
        const scopes = Array.from({ length: 75 }, (_value, index) => ({
            serverId: 'server-a',
            sessionId: `s${index}`,
        }));

        expect(resolveSessionListRowStoreSubscriptionScopes(
            scopes,
            null,
            'viewable',
            new Set(['server-a:s3', 'server-a:s70']),
        )).toEqual([
            { serverId: 'server-a', sessionId: 's3' },
            { serverId: 'server-a', sessionId: 's70' },
        ]);
    });

    it('does not treat stale embedded runtime fields or attention placement as priority subscription keys', () => {
        const embeddedPriorityKeys = buildSessionListEmbeddedPriorityRowKeys([
            {
                type: 'session',
                serverId: 'server-a',
                session: {
                    id: 'stale-completed-row',
                    latestTurnStatus: 'in_progress',
                    thinking: true,
                    hasPendingPermissionRequests: true,
                    hasPendingUserActionRequests: true,
                    lastRuntimeIssue: { message: 'stale issue' },
                },
            },
            {
                type: 'session',
                serverId: 'server-a',
                selected: true,
                session: { id: 'selected-row' },
            },
            {
                type: 'session',
                serverId: 'server-a',
                workingPlacementReason: 'working',
                session: { id: 'working-row' },
            },
            {
                type: 'session',
                serverId: 'server-a',
                // Retained rows stay priority-subscribed: their renderable
                // refreshes are exactly what ends the retained state.
                workingPlacementReason: 'working-retained',
                session: { id: 'retained-row' },
            },
            {
                type: 'session',
                serverId: 'server-a',
                attentionPromotionReason: 'unread',
                session: { id: 'attention-row' },
            },
        ]);

        expect(embeddedPriorityKeys).toEqual(new Set([
            'server-a:selected-row',
            'server-a:working-row',
            'server-a:retained-row',
        ]));
        expect(resolveSessionListRowStoreSubscriptionScopes(
            [
                { serverId: 'server-a', sessionId: 'stale-completed-row' },
                { serverId: 'server-a', sessionId: 'selected-row' },
                { serverId: 'server-a', sessionId: 'working-row' },
                { serverId: 'server-a', sessionId: 'attention-row' },
            ],
            new Set(),
            'viewable',
            embeddedPriorityKeys,
        )).toEqual([
            { serverId: 'server-a', sessionId: 'selected-row' },
            { serverId: 'server-a', sessionId: 'working-row' },
        ]);
    });

    it('does not subscribe every attention row in an attention-heavy virtualized list before viewability is known', () => {
        const scopes = Array.from({ length: 130 }, (_, index) => ({
            serverId: 'server-a',
            sessionId: `attention-${index}`,
        }));
        const embeddedPriorityKeys = buildSessionListEmbeddedPriorityRowKeys(scopes.map((scope) => ({
            type: 'session',
            serverId: scope.serverId,
            attentionPromotionReason: 'failed',
            session: { id: scope.sessionId },
        })));

        expect(embeddedPriorityKeys.size).toBe(0);
        expect(resolveSessionListRowStoreSubscriptionScopes(
            scopes,
            null,
            'viewable',
            embeddedPriorityKeys,
        )).toEqual([]);
    });

    it('narrows subscriptions to viewable session rows', () => {
        const scopes = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's2' },
            { serverId: 'server-b', sessionId: 's1' },
        ];

        expect(resolveSessionListRowStoreSubscriptionScopes(
            scopes,
            new Set(['server-a:s1', 'server-b:s1']),
        )).toEqual([
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-b', sessionId: 's1' },
        ]);
    });

    it('uses the unscoped session id when a row has no server id', () => {
        expect(resolveSessionListRowStoreScopeKey({ sessionId: 'local-session', serverId: null })).toBe('local-session');
    });

    it('reuses row subscription scope arrays when scoped session identities are unchanged', () => {
        const previous: ReadonlyArray<SessionListRowStoreSubscriptionScope> = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: null, sessionId: 's2' },
        ];
        const nextEquivalent: ReadonlyArray<SessionListRowStoreSubscriptionScope> = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: undefined, sessionId: 's2' },
        ];
        const nextChanged: ReadonlyArray<SessionListRowStoreSubscriptionScope> = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's2' },
        ];

        expect(reuseSessionListRowStoreSubscriptionScopes(previous, nextEquivalent)).toBe(previous);
        expect(reuseSessionListRowStoreSubscriptionScopes(previous, nextChanged)).toBe(nextChanged);
    });

    it('reuses row subscription key sets when membership is unchanged', () => {
        const previous = new Set(['server-a:s1', 'server-a:s2']);
        const nextEquivalent = new Set(['server-a:s2', 'server-a:s1']);
        const nextChanged = new Set(['server-a:s1']);

        expect(reuseSessionListRowStoreKeySet(previous, nextEquivalent)).toBe(previous);
        expect(reuseSessionListRowStoreKeySet(previous, nextChanged)).toBe(nextChanged);
        expect(reuseSessionListRowStoreKeySet(null, nextEquivalent)).toBe(nextEquivalent);
    });

    it('summarizes row store subscription telemetry without exposing row identifiers', () => {
        expect(buildSessionListRowStoreSubscriptionTelemetryFields({
            dataActive: true,
            mode: 'viewable',
            priorityReasonCounts: {
                active: 1,
                attention: 2,
                pendingPermission: 1,
                selected: 1,
                workingPlacement: 1,
            },
            priorityRowKeys: new Set(['server-a:s2', 'server-a:s3', 'server-a:s4']),
            subscribedScopes: [
                { serverId: 'server-a', sessionId: 's1' },
                { serverId: 'server-a', sessionId: 's3' },
                { serverId: 'server-a', sessionId: 's4' },
            ],
            totalScopes: [
                { serverId: 'server-a', sessionId: 's1' },
                { serverId: 'server-a', sessionId: 's2' },
                { serverId: 'server-a', sessionId: 's3' },
                { serverId: 'server-a', sessionId: 's4' },
            ],
            visibleRowKeys: new Set(['server-a:s1', 'server-a:s3']),
        })).toEqual({
            allRenderedMode: 0,
            dataActive: 1,
            priorityActiveRows: 1,
            priorityAttentionRows: 2,
            priorityInProgressRows: 0,
            priorityPendingPermissionRows: 1,
            priorityPendingUserActionRows: 0,
            priorityRows: 3,
            priorityRuntimeIssueRows: 0,
            prioritySelectedRows: 1,
            prioritySubscribedRows: 2,
            priorityThinkingRows: 0,
            priorityWorkingPlacementRows: 1,
            subscribedRows: 3,
            totalRows: 4,
            viewabilityKnown: 1,
            viewableMode: 1,
            visibleRows: 2,
        });
    });
});
