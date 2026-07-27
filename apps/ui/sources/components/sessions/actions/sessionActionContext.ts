import { resolveSessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveTerminalControlServiceabilityPolicy } from '@happier-dev/protocol';

import type { SessionActionSession, SessionActionTarget } from './sessionActionTypes';

export function createSessionActionTarget(params: Readonly<{
    session: SessionActionSession;
    serverId?: string | null;
    currentUserId?: string | null;
    isConnected?: boolean;
    isPinned?: boolean;
}>): SessionActionTarget {
    const session = params.session;
    const sessionOwnerId = typeof session.owner === 'string' ? session.owner : null;
    const currentUserOwnsSession = (
        typeof params.currentUserId === 'string'
        && params.currentUserId.length > 0
        && sessionOwnerId === params.currentUserId
    );
    const isOwnedByCurrentUser = currentUserOwnsSession || (
        session.accessLevel == null
        && !sessionOwnerId
    );
    const hasAdminAccess = isOwnedByCurrentUser || session.accessLevel === 'admin';
    const isActive = session.active === true;
    const isArchived = session.archivedAt != null;
    const terminalControlServiceability = 'terminalControlServiceabilityV1' in (session.metadata ?? {})
        ? (session.metadata as SessionListRenderableSession['metadata'])?.terminalControlServiceabilityV1
        : (session as Session).metadata?.terminal?.controlServiceabilityV1;
    const terminalControlPolicy = resolveTerminalControlServiceabilityPolicy(terminalControlServiceability);
    const hasPreservedTerminalHost = terminalControlPolicy.hostPresence === 'preserved';
    const hasStoppableTerminalHost = terminalControlPolicy.canRequestStop;
    const canStop = isOwnedByCurrentUser;
    const canArchive = hasAdminAccess && !isArchived && (!isActive || canStop);

    return {
        session,
        sessionId: session.id,
        serverId: params.serverId ?? null,
        isActive,
        isArchived,
        isConnected: params.isConnected ?? isActive,
        hasStoppableTerminalHost,
        isPinned: params.isPinned === true,
        isOwnedByCurrentUser,
        hasAdminAccess,
        canStop,
        canArchive,
        canRename: hasAdminAccess,
        canDelete: isOwnedByCurrentUser && !isActive && !hasPreservedTerminalHost && params.isConnected !== true,
        readStateAction: isArchived
            ? { kind: 'none', visible: false }
            : resolveSessionReadStateAction(session),
    };
}
