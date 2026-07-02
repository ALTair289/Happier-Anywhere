import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';

type SessionRuntimeStatusFields = Pick<
    Session,
    | 'active'
    | 'activeAt'
    | 'presence'
    | 'thinking'
    | 'thinkingAt'
    | 'latestTurnStatus'
    | 'latestTurnStatusObservedAt'
    | 'runtimeActivityActiveCount'
    | 'runtimeActivityObservedAt'
    | 'runtimeActivityExpiresAt'
    | 'runtimeActivitySourceClass'
    | 'meaningfulActivityAt'
    | 'lastRuntimeIssue'
    | 'pendingPermissionRequestCount'
    | 'pendingUserActionRequestCount'
    | 'pendingRequestObservedAt'
    | 'optimisticThinkingAt'
    | 'thinkingGraceUntil'
>;

function selectSessionRuntimeStatusFields(session: Session): SessionRuntimeStatusFields {
    return {
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        runtimeActivityActiveCount: session.runtimeActivityActiveCount,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt,
        runtimeActivityExpiresAt: session.runtimeActivityExpiresAt,
        runtimeActivitySourceClass: session.runtimeActivitySourceClass,
        meaningfulActivityAt: session.meaningfulActivityAt,
        lastRuntimeIssue: session.lastRuntimeIssue,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount,
        pendingRequestObservedAt: session.pendingRequestObservedAt,
        optimisticThinkingAt: session.optimisticThinkingAt,
        thinkingGraceUntil: session.thinkingGraceUntil,
    };
}

export function useSessionRuntimeStatusSource(session: Session): Session {
    const sessionId = session.id;
    const runtimeFields = storage(
        useShallow((state) => {
            const liveSession = state.sessions[sessionId] ?? null;
            return liveSession ? selectSessionRuntimeStatusFields(liveSession) : null;
        }),
    );

    return React.useMemo(() => {
        if (!runtimeFields) return session;
        return {
            ...session,
            ...runtimeFields,
        };
    }, [runtimeFields, session]);
}
