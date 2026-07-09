import { describe, expect, it } from 'vitest';

import {
    deriveSessionRuntimePresentationState,
    resolveNextSessionRuntimePresentationFreshnessAtMs,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from './deriveSessionRuntimePresentationState';

describe('deriveSessionRuntimePresentationState', () => {
    it('treats a fresh in-progress turn projection as working without legacy presence evidence', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: false,
            activeAt: 0,
            presence: 0,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.runtimeProjectionInProgress).toBe(true);
        expect(runtimeState.runtimeActivelyWorking).toBe(false);
    });

    it('falls back to fresh legacy thinking when turn fields are absent', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(true);
        expect(runtimeState.working).toBe(true);
    });

    it('treats a completed turn projection as authoritative over newer legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not convert stale legacy thinking after a terminal projection into resume catch-up', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.resuming).toBe(false);
    });

    it('presents detached provider runtime activity as background-active without foreground working after the turn completed', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityExpiresAt: nowMs + 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.freshProviderRuntimeActivity).toBe(true);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.backgroundActive).toBe(true);
        expect(runtimeState.activityState).toBe('backgroundActive');
        expect(runtimeState.runtimeActivelyWorking).toBe(false);
        expect(runtimeState.runtimeProjectionInProgress).toBe(false);
        expect(runtimeState.terminalStatus).toBe('completed');
    });

    it('keeps foreground working precedence over detached runtime activity while the turn is active', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 2_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityExpiresAt: nowMs + 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs);

        expect(runtimeState.working).toBe(true);
        expect(runtimeState.backgroundActive).toBe(false);
        expect(runtimeState.activityState).toBe('working');
    });

    it('presents zero runtime activity as idle when there are no foreground signals', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityExpiresAt: nowMs + 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs);

        expect(runtimeState.working).toBe(false);
        expect(runtimeState.backgroundActive).toBe(false);
        expect(runtimeState.activityState).toBe('idle');
    });

    it('marks active online resume catch-up while transcript activity still predates the attach', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: nowMs - 60_000,
            meaningfulActivityAt: nowMs - 60_000,
            latestReadyEventAt: nowMs - 55_000,
        }, nowMs);

        expect(runtimeState.working).toBe(false);
        expect(runtimeState.backgroundActive).toBe(false);
        expect(runtimeState.resuming).toBe(true);
    });

    it('clears resume catch-up presentation after the first post-attach transcript activity', () => {
        const nowMs = 1_000_000;
        const activeAt = nowMs - 10_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: activeAt - 1_000,
            meaningfulActivityAt: activeAt + 100,
            latestReadyEventAt: activeAt - 500,
        }, nowMs);

        expect(runtimeState.resuming).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not retain elapsed detached provider runtime activity while owner presence is live', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 180_000,
            runtimeActivityExpiresAt: nowMs - 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.freshProviderRuntimeActivity).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.runtimeProjectionInProgress).toBe(false);
    });

    it('does not schedule an expiresAt-derived rerender when live owner presence carries expired runtime activity', () => {
        const nowMs = 1_000_000;
        expect(resolveNextSessionRuntimePresentationFreshnessAtMs({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 180_000,
            runtimeActivityExpiresAt: nowMs - 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs)).toBeNull();
    });

    it('does not schedule an expiresAt-derived rerender when live owner presence carries future runtime activity', () => {
        const nowMs = 1_000_000;
        expect(resolveNextSessionRuntimePresentationFreshnessAtMs({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityExpiresAt: nowMs + 300_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs)).toBeNull();
    });

    it('tracks detached provider runtime activity with missing observed timestamp without foreground working', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: null,
            runtimeActivityExpiresAt: nowMs + 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs);

        expect(runtimeState.freshProviderRuntimeActivity).toBe(true);
        expect(runtimeState.working).toBe(false);
    });

    it('treats provider runtime activity with missing source class as working when active count and expiry are valid', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityExpiresAt: nowMs + 60_000,
            runtimeActivitySourceClass: null,
        }, nowMs);

        expect(runtimeState.freshProviderRuntimeActivity).toBe(true);
        expect(runtimeState.working).toBe(true);
    });

    it('does not treat provider runtime activity with missing expiry as working when owner presence is offline', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'offline',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityExpiresAt: null,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs);

        expect(runtimeState.freshProviderRuntimeActivity).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not keep elapsed provider runtime activity working when the runtime owner is not live', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: false,
            activeAt: nowMs - 10_000,
            presence: 0,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 180_000,
            runtimeActivityExpiresAt: nowMs - 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs);

        expect(runtimeState.freshProviderRuntimeActivity).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not keep elapsed provider runtime activity working when owner presence is offline', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'offline',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 180_000,
            runtimeActivityExpiresAt: nowMs - 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        }, nowMs);

        expect(runtimeState.freshProviderRuntimeActivity).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it.each([
        ['idle count', { runtimeActivityActiveCount: 0, runtimeActivitySourceClass: null }],
    ])('does not treat %s provider runtime activity as working', (_label, overrides) => {
        const nowMs = 1_000_000;
        const runtimeActivity = {
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityExpiresAt: nowMs + 60_000,
        };
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            ...runtimeActivity,
            ...overrides,
        }, nowMs);

        expect(runtimeState.freshProviderRuntimeActivity).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('suppresses stale legacy thinking after a terminal turn projection', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 3_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('treats a failed turn projection as authoritative over newer legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('keeps pending permission actionable when the pending request itself is fresh', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: 0,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: nowMs - 1_000,
        }, nowMs);

        expect(runtimeState.working).toBe(false);
        expect(runtimeState.freshPermissionRequired).toBe(true);
        expect(runtimeState.freshActionRequired).toBe(false);
    });

    it('extends stale in-progress projection from a fresh active heartbeat', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
    });

    it('extends stale in-progress projection from a fresh active heartbeat without requiring legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.freshInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.runtimeProjectionInProgress).toBe(true);
        expect(runtimeState.runtimeActivelyWorking).toBe(true);
    });

    it('does not keep an in-progress turn working from newer meaningful activity alone', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: 0,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - 1_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not refresh an in-progress turn from older transcript activity', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 2_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not extend stale in-progress projection from a stale active heartbeat', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not extend an in-progress projection from heartbeat when the observed timestamp is missing', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: null,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
    });
});
