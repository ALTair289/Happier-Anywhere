import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import {
    clearActiveViewingSessionsForServerScopeReset,
    isSessionVisible,
} from '@/sync/domains/session/activeViewingSession';
import {
    clearMountedSessionRealtimeTranscriptConsumers,
    readMountedSessionRealtimeTranscriptConsumerSessionIds,
    readMountedSessionTranscriptConsumerSessionIdsForRetention,
} from '@/sync/runtime/sessionRealtimeTranscriptConsumers';

import { useSessionSurfaceActivation } from './useSessionSurfaceActivation';

describe('useSessionSurfaceActivation', () => {
    beforeEach(() => {
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
    });

    afterEach(() => {
        standardCleanup();
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
    });

    it('marks route-visible surfaces before session content is loaded and scopes them to the server', async () => {
        const hook = await renderHook((input: Parameters<typeof useSessionSurfaceActivation>[0]) => (
            useSessionSurfaceActivation(input)
        ), {
            initialProps: {
                sessionId: 'shared-session',
                serverId: 'server-a',
                surfaceVisible: true,
                surfaceFocused: false,
            },
        });

        expect(hook.getCurrent()).toEqual({
            isSurfaceFocused: false,
            isVisible: true,
        });
        expect(isSessionVisible('shared-session', 'server-a')).toBe(true);
        expect(isSessionVisible('shared-session', 'server-b')).toBe(false);

        await hook.rerender({
            sessionId: 'shared-session',
            serverId: 'server-b',
            surfaceVisible: true,
            surfaceFocused: true,
        });

        expect(hook.getCurrent()).toEqual({
            isSurfaceFocused: true,
            isVisible: true,
        });
        expect(isSessionVisible('shared-session', 'server-a')).toBe(false);
        expect(isSessionVisible('shared-session', 'server-b')).toBe(true);

        await hook.rerender({
            sessionId: 'shared-session',
            serverId: 'server-b',
            surfaceVisible: false,
            surfaceFocused: false,
        });

        expect(hook.getCurrent()).toEqual({
            isSurfaceFocused: false,
            isVisible: false,
        });
        expect(isSessionVisible('shared-session', 'server-b')).toBe(false);
    });

    it('holds a transcript retention mount for the full component lifetime, including hidden-but-mounted back-stack surfaces', async () => {
        const hook = await renderHook((input: Parameters<typeof useSessionSurfaceActivation>[0]) => (
            useSessionSurfaceActivation(input)
        ), {
            initialProps: {
                sessionId: 's-back-stack',
                surfaceVisible: true,
                surfaceFocused: true,
            },
        });

        try {
            expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual(['s-back-stack']);
            // The retention hold must not widen realtime full-content routing.
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds()).toEqual([]);

            // Covered by another screen (back-swipe candidate): visibility refcount releases,
            // but the mounted view keeps its transcript retained.
            await hook.rerender({
                sessionId: 's-back-stack',
                surfaceVisible: false,
                surfaceFocused: false,
            });
            expect(isSessionVisible('s-back-stack')).toBe(false);
            expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual(['s-back-stack']);
        } finally {
            await hook.unmount();
        }

        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
    });

    it('does not register a retention hold for blank session ids', async () => {
        const hook = await renderHook((input: Parameters<typeof useSessionSurfaceActivation>[0]) => (
            useSessionSurfaceActivation(input)
        ), {
            initialProps: {
                sessionId: '   ',
                surfaceVisible: false,
                surfaceFocused: false,
            },
        });

        try {
            expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
        } finally {
            await hook.unmount();
        }
    });
});
