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

    it('uses fresh legacy thinking evidence for working placement without detached runtime activity', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            separateBackgroundWork: true,
            session: makeSession({
                active: true,
                activeAt: nowMs - 1_000,
                presence: 'online',
                thinking: true,
                thinkingAt: nowMs - 1_000,
                latestTurnStatus: undefined,
                latestTurnStatusObservedAt: undefined,
                lastRuntimeIssue: null,
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityExpiresAt: null,
                runtimeActivitySourceClass: null,
            }),
        })).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: false,
        });
    });

    it('uses live detached provider runtime activity for working placement after the foreground turn completed by default', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 180_000,
                presence: 0,
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

    it('projects live detached provider runtime activity into a separate background working placement when requested', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            separateBackgroundWork: true,
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
            kind: 'background_working',
            timestamp: null,
            retainedWorking: false,
        });
    });

    it('does not use expired detached provider runtime activity for working placement', () => {
        const nowMs = 10_000;

        const placement = projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: false,
                activeAt: nowMs - 180_000,
                presence: 0,
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

    it('projects retained working placement for stale retained candidates', () => {
        const now = 1_000_000;
        const placement = projectSessionListPlacement({
            session: makeSession({
                active: true,
                presence: 'online',
                activeAt: now - 600_000,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: now - 600_000,
            }),
            sessionKey: 'server-a:s1',
            retainedWorkingSessionKeys: ['server-a:s1'],
            nowMs: now,
        });

        expect(placement).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: true,
        });
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
