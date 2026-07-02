import { describe, expect, it } from 'vitest';

import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildSessionListRenderableFromCacheEntry,
    buildSessionListCacheEntryFromRenderable,
} from './warmCacheAdapters';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

describe('warmCacheAdapters', () => {
    it('preserves previous session cache metadata and agent-state flags while a replacement renderable is still stale', () => {
        const previousEntry = {
            sessionId: 's1',
            metadataVersion: 1,
            agentStateVersion: 3,
            updatedAt: 10,
            createdAt: 5,
            active: true,
            activeAt: 10,
            archivedAt: null,
            pendingCount: 1,
            pendingVersion: 2,
            name: 'Cached title',
            path: '/home/u/repo',
            homeDir: '/home/u',
            machineId: 'm1',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        };

        const nextRenderable = {
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 4,
            pendingVersion: 5,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
        };

        const entry = (buildSessionListCacheEntryFromRenderable as any)(nextRenderable, previousEntry);

        expect(entry).toEqual(expect.objectContaining({
            sessionId: 's1',
            metadataVersion: 1,
            agentStateVersion: 3,
            updatedAt: 20,
            pendingCount: 4,
            pendingVersion: 5,
            name: 'Cached title',
            path: '/home/u/repo',
            homeDir: '/home/u',
            machineId: 'm1',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        }));
    });

    it('preserves previous machine display cache metadata while a replacement renderable is still stale', () => {
        const previousEntry = {
            machineId: 'm1',
            metadataVersion: 2,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            revokedAt: null,
            displayName: 'Cached machine',
            host: 'mbp',
            homeDir: '/home/u',
        };

        const nextRenderable = {
            id: 'm1',
            updatedAt: 20,
            active: true,
            activeAt: 20,
            revokedAt: null,
            metadataVersion: 3,
            metadata: null,
        };

        const entry = (buildMachineDisplayCacheEntryFromRenderable as any)(nextRenderable, previousEntry);

        expect(entry).toEqual(expect.objectContaining({
            machineId: 'm1',
            metadataVersion: 2,
            updatedAt: 20,
            activeAt: 20,
            displayName: 'Cached machine',
            host: 'mbp',
            homeDir: '/home/u',
        }));
    });

    it('roundtrips keepVisibleWhenInactive through cache entries', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: false,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                directSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
            keepVisibleWhenInactive: true,
        } as any);

        expect(entry.keepVisibleWhenInactive).toBe(true);
        expect(buildSessionListRenderableFromCacheEntry(entry).keepVisibleWhenInactive).toBe(true);
    });

    it('roundtrips session unread state through cache entries', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 7,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            lastViewedSessionSeq: 4,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                directSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasUnreadMessages: true,
        });

        expect(entry).toEqual(expect.objectContaining({
            seq: 7,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: true,
        }));
        expect(buildSessionListRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            seq: 7,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: true,
        }));
    });

    it('roundtrips durable session status and attention projection through cache entries', () => {
        const renderable = {
            id: 's_attention',
            seq: 12,
            createdAt: 5,
            updatedAt: 20,
            meaningfulActivityAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 1,
            pendingVersion: 4,
            lastViewedSessionSeq: 10,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Needs review',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                directSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 500,
            presence: 'online',
            latestTurnId: 'turn-failed',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'auth_error',
                source: 'auth_error',
                occurredAt: 1_200,
            },
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 1_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityExpiresAt: 10_000,
            runtimeActivitySourceClass: 'provider_detached_task',
            rollbackEligibleTurnStarts: [2, 4],
            hasUnreadMessages: true,
        } satisfies SessionListRenderableSession;

        const entry = buildSessionListCacheEntryFromRenderable(renderable);

        expect(entry).toEqual(expect.objectContaining({
            latestTurnId: 'turn-failed',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: expect.objectContaining({ code: 'auth_error' }),
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            pendingRequestObservedAt: 1_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityExpiresAt: 10_000,
            runtimeActivitySourceClass: 'provider_detached_task',
            rollbackEligibleTurnStarts: [2, 4],
        }));
        expect(buildSessionListRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            latestTurnId: 'turn-failed',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: expect.objectContaining({ code: 'auth_error' }),
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            pendingRequestObservedAt: 1_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityExpiresAt: 10_000,
            runtimeActivitySourceClass: 'provider_detached_task',
            rollbackEligibleTurnStarts: [2, 4],
        }));
    });

    it('does not hydrate placeholder session metadata from an empty warm-cache identity', () => {
        const renderable = buildSessionListRenderableFromCacheEntry({
            sessionId: 's1',
            seq: 7,
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 20,
            createdAt: 5,
            active: false,
            activeAt: 5,
            archivedAt: null,
            lastViewedSessionSeq: null,
            pendingCount: 0,
            pendingVersion: 0,
            summaryText: null,
            path: '',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: null,
            directSessionV1: null,
            hiddenSystemSession: false,
            keepVisibleWhenInactive: false,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
            hasUnreadMessages: true,
        });

        expect(renderable.metadata).toBeNull();
        expect(renderable.metadataUnavailable).toBe(true);
    });

    it('does not preserve placeholder session metadata from a previous empty warm-cache identity', () => {
        const previousEntry = {
            sessionId: 's1',
            seq: 7,
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 20,
            createdAt: 5,
            active: false,
            activeAt: 5,
            archivedAt: null,
            lastViewedSessionSeq: null,
            pendingCount: 0,
            pendingVersion: 0,
            summaryText: null,
            path: '',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: null,
            directSessionV1: null,
            hiddenSystemSession: false,
            keepVisibleWhenInactive: false,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
            hasUnreadMessages: true,
        };

        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 8,
            createdAt: 5,
            updatedAt: 30,
            active: false,
            activeAt: 5,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 5,
            metadataUnavailable: true,
        } as any, previousEntry);

        expect(entry.metadataVersion).toBe(1);
        expect(entry.path).toBe('');
        expect(entry.name).toBeUndefined();
    });
});
