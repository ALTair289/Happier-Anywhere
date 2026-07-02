import { describe, expect, it } from 'vitest';

import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import type { SessionListRenderableSession } from '../sessionListRenderable';
import { projectSessionListPlacement } from './sessionListPlacementProjection';

const usageLimitIssue: SessionRuntimeIssueV1 = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    occurredAt: 100,
    provider: 'claude',
    usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
    },
};

function makeSession(overrides: Partial<SessionListRenderableSession>): SessionListRenderableSession {
    return {
        id: 's1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        ...overrides,
    };
}

describe('projectSessionListPlacement', () => {
    it('uses fresh canonical in-progress turn status for working placement without legacy presence evidence', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: false,
                activeAt: 0,
                presence: 0,
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: nowMs - 1_000,
                lastRuntimeIssue: null,
            }),
        })).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: false,
        });
    });

    it('uses provider runtime activity for working placement through the shared presentation selector', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 1_000,
                presence: 'online',
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 2_000,
                lastRuntimeIssue: null,
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 1_000,
                runtimeActivityExpiresAt: nowMs + 60_000,
                runtimeActivitySourceClass: 'provider_detached_task',
            }),
        })).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: false,
        });
    });

    it('does not use stale provider runtime activity for working placement even when the session is active online', () => {
        const nowMs = 10_000;

        const placement = projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 1_000,
                presence: 'online',
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 2_000,
                lastRuntimeIssue: null,
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 180_000,
                runtimeActivityExpiresAt: nowMs - 1,
                runtimeActivitySourceClass: 'provider_detached_task',
            }),
        });

        expect(placement.kind).not.toBe('working');
        expect(placement.retainedWorking).toBe(false);
    });

    it('keeps terminal turn projection authoritative over fresh legacy thinking evidence', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 1_000,
                presence: 'online',
                thinking: true,
                thinkingAt: nowMs - 1_000,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: nowMs - 5_000,
                lastRuntimeIssue: usageLimitIssue,
            }),
        })).toEqual({
            kind: 'failed',
            timestamp: 100,
            retainedWorking: false,
        });
    });

    it('promotes an active failed session even when it has already been read', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                active: true,
                seq: 10,
                lastViewedSessionSeq: 10,
                hasUnreadMessages: false,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: 1_000,
                lastRuntimeIssue: {
                    ...usageLimitIssue,
                    occurredAt: 1_000,
                },
            }),
        })).toEqual({
            kind: 'failed',
            timestamp: 1_000,
            retainedWorking: false,
        });
    });

    it('promotes blocked pending delivery as action-required attention', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                pendingBlockedCount: 1,
                createdAt: 100,
                updatedAt: 2_000,
                hasPendingUserActionRequests: false,
                hasPendingPermissionRequests: false,
                pendingRequestObservedAt: undefined,
            }),
        })).toEqual({
            kind: 'action_required',
            timestamp: 2_000,
            retainedWorking: false,
        });
    });

    it('promotes an inactive failed session only while it has unread activity', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                active: false,
                seq: 11,
                lastViewedSessionSeq: 10,
                hasUnreadMessages: true,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: 1_000,
                lastRuntimeIssue: {
                    ...usageLimitIssue,
                    occurredAt: 1_000,
                },
            }),
        })).toEqual({
            kind: 'failed',
            timestamp: 1_000,
            retainedWorking: false,
        });

        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                active: false,
                seq: 10,
                lastViewedSessionSeq: 10,
                hasUnreadMessages: false,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: 1_000,
                lastRuntimeIssue: {
                    ...usageLimitIssue,
                    occurredAt: 1_000,
                },
            }),
        })).toEqual({
            kind: 'none',
            timestamp: null,
            retainedWorking: false,
        });
    });

    it('keeps active failed sessions promoted after later diagnostic/control activity', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                active: true,
                seq: 11,
                lastViewedSessionSeq: 10,
                hasUnreadMessages: true,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: 1_000,
                meaningfulActivityAt: 2_500,
                lastRuntimeIssue: {
                    ...usageLimitIssue,
                    occurredAt: 1_000,
                },
            }),
        })).toEqual({
            kind: 'failed',
            timestamp: 1_000,
            retainedWorking: false,
        });
    });
});
