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
    | 'runtimeActivityState'
    | 'runtimeActivityActiveCount'
    | 'runtimeActivityObservedAt'
    | 'runtimeActivityRevision'
    | 'meaningfulActivityAt'
    | 'lastRuntimeIssue'
    | 'pendingPermissionRequestCount'
    | 'pendingUserActionRequestCount'
    | 'pendingRequestObservedAt'
    | 'optimisticThinkingAt'
    | 'resumingAt'
    | 'thinkingGraceUntil'
>;

type UseSessionRuntimeStatusSourceOptions = Readonly<{
    subscribeToRuntimeActivity?: boolean;
}>;

function selectSessionRuntimeStatusFields(
    session: Session,
    subscribeToRuntimeActivity: boolean,
): Partial<SessionRuntimeStatusFields> {
    const foregroundFields = {
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        meaningfulActivityAt: session.meaningfulActivityAt,
        lastRuntimeIssue: session.lastRuntimeIssue,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount,
        pendingRequestObservedAt: session.pendingRequestObservedAt,
        optimisticThinkingAt: session.optimisticThinkingAt,
        resumingAt: session.resumingAt,
        thinkingGraceUntil: session.thinkingGraceUntil,
    };
    return subscribeToRuntimeActivity
        ? {
            ...foregroundFields,
            runtimeActivityState: session.runtimeActivityState,
            runtimeActivityActiveCount: session.runtimeActivityActiveCount,
            runtimeActivityObservedAt: session.runtimeActivityObservedAt,
            runtimeActivityRevision: session.runtimeActivityRevision,
        }
        : foregroundFields;
}

export function useSessionRuntimeStatusSource(
    session: Session,
    options: UseSessionRuntimeStatusSourceOptions = {},
): Session {
    const sessionId = session.id;
    const subscribeToRuntimeActivity = options.subscribeToRuntimeActivity !== false;
    const runtimeFields = storage(
        useShallow((state) => {
            const liveSession = state.sessions[sessionId] ?? null;
            return liveSession
                ? selectSessionRuntimeStatusFields(liveSession, subscribeToRuntimeActivity)
                : null;
        }),
    );

    return React.useMemo(() => {
        if (!runtimeFields && subscribeToRuntimeActivity) return session;
        return {
            ...session,
            ...runtimeFields,
            ...(subscribeToRuntimeActivity
                ? {}
                : {
                    runtimeActivityState: undefined,
                    runtimeActivityActiveCount: undefined,
                    runtimeActivityObservedAt: undefined,
                    runtimeActivityRevision: undefined,
                }),
        };
    }, [runtimeFields, session, subscribeToRuntimeActivity]);
}
