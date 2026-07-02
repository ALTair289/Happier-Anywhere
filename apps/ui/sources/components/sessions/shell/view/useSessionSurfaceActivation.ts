import * as React from 'react';

import {
    markSessionHidden,
    markSessionVisible,
} from '@/sync/domains/session/activeViewingSession';
import { registerSessionTranscriptRetentionConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';

export type UseSessionSurfaceActivationInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
    surfaceFocused: boolean;
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

    React.useLayoutEffect(() => {
        if (!sessionId || !input.surfaceVisible) return;
        markSessionVisible(sessionId, input.serverId);
        return () => {
            markSessionHidden(sessionId, input.serverId);
        };
    }, [input.serverId, input.surfaceVisible, sessionId]);

    // Mount-lifetime transcript retention hold (NOT gated on surfaceVisible): a
    // hidden-but-mounted back-stack SessionView still renders its transcript, so the
    // eviction sweep must treat it as a mounted consumer until real unmount.
    React.useEffect(() => {
        if (!sessionId) return;
        return registerSessionTranscriptRetentionConsumer(sessionId, input.serverId);
    }, [input.serverId, sessionId]);

    const hasVisibleSession = sessionId.length > 0 && input.surfaceVisible;
    return React.useMemo(() => ({
        isSurfaceFocused: hasVisibleSession && input.surfaceFocused,
        isVisible: hasVisibleSession,
    }), [hasVisibleSession, input.surfaceFocused]);
}
