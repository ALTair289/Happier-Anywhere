import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    clearActiveViewingSessionsForNonSessionRoute,
    clearActiveViewingSessionsForServerScopeReset,
    isSessionVisible,
} from '@/sync/domains/session/activeViewingSession';
import { createSessionTranscriptRetentionController } from '@/sync/engine/sessions/sessionTranscriptRetention';
import { resolveSessionLiveConsumption } from '@/sync/runtime/sessionLiveConsumption';
import {
    clearMountedSessionRealtimeTranscriptConsumers,
    readMountedSessionRealtimeTranscriptConsumerSessionIds,
    readMountedSessionTranscriptConsumerSessionIdsForRetention,
} from '@/sync/runtime/sessionRealtimeTranscriptConsumers';

import { useSessionSurfaceActivation } from './useSessionSurfaceActivation';

describe('useSessionSurfaceActivation', () => {
    const sessionIds = ['s1', 's2', 's3', 's4', 's5'] as const;

    beforeEach(() => {
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
    });

    afterEach(() => {
        standardCleanup();
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
        vi.useRealTimers();
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

    it('re-registers a still-mounted visible surface after server-scoped runtime state resets', async () => {
        const onSessionVisible = vi.fn();
        const hook = await renderHook((input: Parameters<typeof useSessionSurfaceActivation>[0]) => (
            useSessionSurfaceActivation(input)
        ), {
            initialProps: {
                sessionId: 'focused-session',
                serverId: 'server-a',
                onSessionVisible,
                surfaceVisible: true,
                surfaceFocused: true,
            },
        });

        expect(isSessionVisible('focused-session', 'server-a')).toBe(true);
        expect(onSessionVisible).toHaveBeenCalledTimes(1);
        expect(onSessionVisible).toHaveBeenLastCalledWith('focused-session');

        await act(async () => {
            clearActiveViewingSessionsForServerScopeReset();
        });

        expect(isSessionVisible('focused-session', 'server-a')).toBe(true);
        expect(onSessionVisible).toHaveBeenCalledTimes(2);
        expect(onSessionVisible).toHaveBeenLastCalledWith('focused-session');
        expect(resolveSessionLiveConsumption('focused-session', 'server-a')).toEqual({
            isVisible: true,
            isFullContentConsumer: true,
        });
        await hook.unmount();
        expect(isSessionVisible('focused-session', 'server-a')).toBe(false);
    });

    it('does not reactivate a retained session when navigation explicitly clears visibility for a non-session route', async () => {
        const onSessionVisible = vi.fn();
        const hook = await renderHook(useSessionSurfaceActivation, {
            initialProps: {
                sessionId: 'retained-session',
                serverId: 'server-a',
                onSessionVisible,
                surfaceVisible: true,
                surfaceFocused: true,
            },
        });

        expect(onSessionVisible).toHaveBeenCalledTimes(1);

        await act(async () => {
            expect(clearActiveViewingSessionsForNonSessionRoute('/settings')).toBe(true);
        });

        expect(isSessionVisible('retained-session', 'server-a')).toBe(false);
        expect(onSessionVisible).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('restores every mounted visibility hold without collapsing same-session refcounts', async () => {
        const input = {
            sessionId: 'shared-focused-session',
            serverId: 'server-a',
            surfaceVisible: true,
            surfaceFocused: true,
        };
        const first = await renderHook(useSessionSurfaceActivation, { initialProps: input });
        const second = await renderHook(useSessionSurfaceActivation, { initialProps: input });

        await act(async () => {
            clearActiveViewingSessionsForServerScopeReset();
        });

        expect(isSessionVisible('shared-focused-session', 'server-a')).toBe(true);
        await first.unmount();
        expect(isSessionVisible('shared-focused-session', 'server-a')).toBe(true);
        await second.unmount();
        expect(isSessionVisible('shared-focused-session', 'server-a')).toBe(false);
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

    it('releases mounted web surfaces once they leave the displayed pane set so eviction can use LRU and grace eligibility', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);

        type ActivationInput = Parameters<typeof useSessionSurfaceActivation>[0] & {
            surfaceRetained?: boolean;
        };

        const MountedSessionSurfaces = React.memo(function MountedSessionSurfaces(props: Readonly<{
            retainedSessionIds: ReadonlySet<string>;
            visibleSessionIds: ReadonlySet<string>;
        }>) {
            return (
                <>
                    {sessionIds.map((sessionId) => (
                        <MountedSessionSurface
                            key={sessionId}
                            sessionId={sessionId}
                            retained={props.retainedSessionIds.has(sessionId)}
                            visible={props.visibleSessionIds.has(sessionId)}
                        />
                    ))}
                </>
            );
        });

        const MountedSessionSurface = React.memo(function MountedSessionSurface(props: Readonly<{
            sessionId: string;
            retained: boolean;
            visible: boolean;
        }>) {
            const input: ActivationInput = {
                sessionId: props.sessionId,
                surfaceFocused: props.visible,
                surfaceRetained: props.retained,
                surfaceVisible: props.visible,
            };
            useSessionSurfaceActivation(input);
            return null;
        });

        const screen = await renderScreen(
            <MountedSessionSurfaces
                retainedSessionIds={new Set(sessionIds)}
                visibleSessionIds={new Set(['s5'])}
            />,
        );

        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention().sort()).toEqual([...sessionIds].sort());

        await screen.update(
            <MountedSessionSurfaces
                retainedSessionIds={new Set()}
                visibleSessionIds={new Set()}
            />,
        );

        for (const sessionId of sessionIds) {
            expect(isSessionVisible(sessionId)).toBe(false);
        }
        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds()).toEqual([]);
        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);

        const evicted: string[] = [];
        const controller = createSessionTranscriptRetentionController({
            readHydratedSessionIds: () => sessionIds,
            readProtectedSessionIds: () => new Set(readMountedSessionTranscriptConsumerSessionIdsForRetention()),
            readLastViewedAtBySessionId: () => ({
                s1: 1,
                s2: 2,
                s3: 3,
                s4: 4,
                s5: 5,
            }),
            evictSessionTranscript: (sessionId) => {
                evicted.push(sessionId);
            },
            tuning: {
                recentKeepCount: 3,
                graceMs: 180_000,
                sweepDebounceMs: 1_000,
            },
            now: () => Date.now(),
        });

        try {
            controller.scheduleSweep();
            await vi.advanceTimersByTimeAsync(1_000);
            await vi.advanceTimersByTimeAsync(180_000);
        } finally {
            controller.dispose();
        }

        expect([...evicted].sort()).toEqual(['s1', 's2']);
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
