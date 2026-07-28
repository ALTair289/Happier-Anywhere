import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';
import type { PetCompanionActivitySession } from './petCompanionActivityTypes';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';

function createSession(partial: Partial<PetCompanionActivitySession>): PetCompanionActivitySession {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
        active: true,
        activeAt: 1_000,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...partial,
    };
}

describe('buildPetCompanionActivityModel', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses wall-clock time for omitted nowMs so stale runtime signals stay stale', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session = createSession({
            thinking: true,
            thinkingAt: 1_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
        });

        expect(model.state).toBe('idle');
        expect(model.trayItems).toEqual([]);
    });

    it('maps projected failed turn status to failed activity', () => {
        const session = createSession({
            id: 'turn-failed-session',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 2_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 3_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'failed',
            reason: 'failed',
            sessionId: session.id,
        });
    });

    it('maps projected runtime issue to failed activity', () => {
        const runtimeIssue: SessionRuntimeIssueV1 = {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'provider_session_error',
            source: 'provider_session_error',
            occurredAt: 2_000,
        };
        const session = createSession({
            id: 'runtime-issue-session',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 2_000,
            lastRuntimeIssue: runtimeIssue,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 3_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'failed',
            reason: 'failed',
            sessionId: session.id,
        });
    });

    it('ignores historical transcript failure signals after the projected turn recovers', () => {
        const session = createSession({
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 3_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 4_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: true,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('expires running activity from the latest runtime signal rather than render time', () => {
        const signalAtMs = 1_000;
        const session = createSession({
            id: 'running-expiry-session',
            thinking: true,
            thinkingAt: signalAtMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: signalAtMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: signalAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1,
        });

        expect(model).toMatchObject({
            state: 'running',
            reason: 'running',
            sessionId: session.id,
        });
        expect(model.trayItems[0]).toEqual(expect.objectContaining({
            status: 'running',
            expiresAtMs: signalAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
        }));
    });

    it('keeps running activity alive from a fresh active heartbeat', () => {
        const staleSignalAtMs = 1_000;
        const activeAtMs = 50_000;
        const session = createSession({
            id: 'running-heartbeat-session',
            active: true,
            activeAt: activeAtMs,
            thinking: true,
            thinkingAt: staleSignalAtMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: staleSignalAtMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: activeAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1,
        });

        expect(model).toMatchObject({
            state: 'running',
            reason: 'running',
            sessionId: session.id,
        });
        expect(model.trayItems[0]).toEqual(expect.objectContaining({
            status: 'running',
            expiresAtMs: activeAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
        }));
    });

    it('does not keep running activity alive from meaningful activity alone', () => {
        const nowMs = 1_000_000;
        const session = createSession({
            id: 'running-meaningful-activity-session',
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - 1_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs,
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('ignores projected background activity', () => {
        const session = createSession({
            id: 'background-activity-session',
            thinking: false,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 7,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 10_000_000,
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('does not reinterpret projected unknown as running from elapsed time', () => {
        const session = createSession({
            id: 'unknown-activity-session',
            thinking: false,
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 8,
        });

        expect(buildPetCompanionActivityModel({ sessions: [session], nowMs: 5_000 })).toMatchObject({
            state: 'idle',
            reason: 'idle',
        });
    });
});
