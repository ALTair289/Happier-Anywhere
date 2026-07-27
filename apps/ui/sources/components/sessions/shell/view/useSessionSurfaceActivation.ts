import * as React from 'react';

import {
    getActiveViewingSessionResetVersion,
    registerSessionVisibleSurface,
    subscribeActiveViewingSessionReset,
} from '@/sync/domains/session/activeViewingSession';
import { registerSessionTranscriptRetentionConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';

export type UseSessionSurfaceActivationInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
    onSessionVisible?: (sessionId: string) => void;
    surfaceFocused: boolean;
    /**
     * Whether this mounted surface is still part of the user-reachable surface set.
     * Defaults to true so hidden native back-stack screens remain protected while
     * web pane hosts can release mounted routes once they leave the displayed pane set.
     */
    surfaceRetained?: boolean;
    surfaceVisible: boolean;
}>;

export type UseSessionSurfaceActivationResult = Readonly<{
    isSurfaceFocused: boolean;
    isVisible: boolean;
}>;

function normalizeSessionId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function useSessionSurfaceActivation(
    input: UseSessionSurfaceActivationInput,
): UseSessionSurfaceActivationResult {
    const sessionId = normalizeSessionId(input.sessionId);
    const visibilityResetVersion = React.useSyncExternalStore(
        subscribeActiveViewingSessionReset,
        getActiveViewingSessionResetVersion,
        getActiveViewingSessionResetVersion,
    );

    React.useLayoutEffect(() => {
        if (!sessionId || !input.surfaceVisible) return;
        const releaseVisibleSurface = registerSessionVisibleSurface(sessionId, input.serverId);
        input.onSessionVisible?.(sessionId);
        return releaseVisibleSurface;
    }, [
        input.onSessionVisible,
        input.serverId,
        input.surfaceVisible,
        sessionId,
        visibilityResetVersion,
    ]);

    // Transcript retention hold (NOT gated on surfaceVisible by default): a
    // hidden-but-mounted back-stack SessionView still renders its transcript, so the
    // eviction sweep must treat it as a retained consumer until real unmount. Web
    // pane hosts pass surfaceRetained=false when a mounted route is no longer displayed.
    React.useEffect(() => {
        if (!sessionId || input.surfaceRetained === false) return;
        return registerSessionTranscriptRetentionConsumer(sessionId, input.serverId);
    }, [input.serverId, input.surfaceRetained, sessionId]);

    const hasVisibleSession = sessionId.length > 0 && input.surfaceVisible;
    return React.useMemo(() => ({
        isSurfaceFocused: hasVisibleSession && input.surfaceFocused,
        isVisible: hasVisibleSession,
    }), [hasVisibleSession, input.surfaceFocused]);
}
