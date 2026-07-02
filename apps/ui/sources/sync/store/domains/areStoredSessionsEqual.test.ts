import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { areStoredSessionsEqual } from './areStoredSessionsEqual';

function session(overrides: Partial<Session> & {
    latestTurnId?: unknown;
    latestTurnStatus?: unknown;
    lastRuntimeIssue?: unknown;
    pendingRequestObservedAt?: unknown;
    rollbackEligibleTurnStarts?: unknown;
} = {}): Session {
    return {
        id: 's1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    } as Session;
}

describe('areStoredSessionsEqual', () => {
    it('detects latest turn id changes', () => {
        expect(areStoredSessionsEqual(
            session({ latestTurnId: 'turn-1' }),
            session({ latestTurnId: 'turn-2' }),
        )).toBe(false);
    });

    it('detects primary turn status changes', () => {
        expect(areStoredSessionsEqual(
            session({ latestTurnStatus: 'in_progress' }),
            session({ latestTurnStatus: 'failed' }),
        )).toBe(false);
    });

    it('detects runtime issue projection changes', () => {
        expect(areStoredSessionsEqual(
            session({
                latestTurnStatus: 'failed',
                lastRuntimeIssue: {
                    v: 1,
                    scope: 'primary_session',
                    status: 'failed',
                    code: 'auth_error',
                    source: 'auth_error',
                    occurredAt: 1,
                },
            }),
            session({
                latestTurnStatus: 'failed',
                lastRuntimeIssue: null,
            }),
        )).toBe(false);
    });

    it('detects pending request observation changes', () => {
        expect(areStoredSessionsEqual(
            session({ pendingRequestObservedAt: 100 }),
            session({ pendingRequestObservedAt: 200 }),
        )).toBe(false);
    });

    it('detects rollback-eligible turn start changes', () => {
        expect(areStoredSessionsEqual(
            session({ rollbackEligibleTurnStarts: [1] }),
            session({ rollbackEligibleTurnStarts: [1, 3] }),
        )).toBe(false);
    });

    it('detects runtime activity projection changes so raw lease updates are retained', () => {
        expect(areStoredSessionsEqual(
            session({
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 100,
                runtimeActivityExpiresAt: 200,
                runtimeActivitySourceClass: 'provider_detached_task',
            }),
            session({
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 150,
                runtimeActivityExpiresAt: 250,
                runtimeActivitySourceClass: 'provider_detached_task',
            }),
        )).toBe(false);
    });

    it('detects runtime activity start and clear transitions', () => {
        expect(areStoredSessionsEqual(
            session({
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityExpiresAt: null,
                runtimeActivitySourceClass: null,
            }),
            session({
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 100,
                runtimeActivityExpiresAt: 200,
                runtimeActivitySourceClass: 'provider_detached_task',
            }),
        )).toBe(false);
    });
});
