import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { SessionPending } from '@/sync/store/domains/pending';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import type { SessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionRowAttentionState, SessionRowDensity, SessionRowPresentation } from './resolveSessionRowPresentation';

export type SessionListRowSessionItem = Extract<SessionListViewItem, { type: 'session' }>;
export type SessionListSessionItem = SessionListRowSessionItem & { selected?: boolean };

export type SessionListRowStateSnapshot = Readonly<{
    session: Session | undefined;
    renderable: SessionListRenderableSession | undefined;
    messages: SessionMessages | undefined;
    pending: SessionPending | undefined;
}>;

export type SessionListRowStoreState = Readonly<{
    activeServerId?: string | null;
    sessions?: Readonly<Record<string, Session | undefined>>;
    sessionListRenderables?: Readonly<Record<string, SessionListRenderableSession | undefined>>;
    sessionMessages?: Readonly<Record<string, SessionMessages | undefined>>;
    sessionPending?: Readonly<Record<string, SessionPending | undefined>>;
}>;

export type SessionListRowPresentationSettings = Readonly<{
    currentUserId: string | null;
    density: SessionRowDensity;
    compact: boolean;
    compactMinimal: boolean;
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
    activeColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    workingIndicatorMode: 'spinner' | 'pulse';
    workingTextMode: 'animated' | 'static';
    statusColors: Readonly<{
        connected: string;
        connecting: string;
        actionRequired: string;
        disconnected: string;
        error: string;
        default: string;
    }>;
    hideInactiveSessions: boolean;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
    tagsEnabled: boolean;
    sessionTagsByKey: Readonly<Record<string, readonly string[]>>;
    allKnownTags: readonly string[];
    pinnedSessionKeys: readonly string[];
    hasMultipleMachines: boolean;
    reachableSessionDisplayByKey: Readonly<Record<string, {
        workspaceSubtitle?: string;
        machineLabel?: string;
        workspaceSubtitleEllipsizeMode?: 'head' | 'tail';
    } | undefined>>;
    folderViewEnabled: boolean;
    relativeNowMs: number;
    runtimeNowMs: number;
}>;

export type SessionListRowModel = Readonly<{
    rowKey: string;
    sessionId: string;
    serverId: string | null;
    serverName?: string;
    treeRowId: string;
    testID: string;
    dataIndex: number;
    session: Session | SessionListRenderableSession;
    status: SessionStatus;
    statusSignature: string;
    nextRuntimeFreshnessAtMs: number | null;
    secondaryLineMode: SessionListSecondaryLineMode;
    attention: Readonly<{
        listState: import('@/sync/domains/session/listing/deriveSessionListActivity').SessionListAttentionState;
        rowState: SessionRowAttentionState;
    }>;
    presentation: SessionRowPresentation;
    activity: Readonly<{
        mode: 'meaningful' | 'updatedAt';
        timestamp: number | null;
        label: string;
        bucket: string;
    }>;
    isIdentityLoading: boolean;
    title: string;
    subtitle: string;
    subtitleEllipsizeMode: 'head' | 'tail';
    groupKey: string;
    groupKind: SessionListRowSessionItem['groupKind'] | null;
    section: SessionListRowSessionItem['section'] | 'recent' | 'pinned' | 'archived' | null;
    variant: SessionListRowSessionItem['variant'] | null;
    folder: Readonly<{ id: string | null; depth: number }>;
    adjacency: Readonly<{ isFirst: boolean; isLast: boolean; isSingle: boolean }>;
    isSelected: boolean;
    isPinned: boolean;
    isArchived: boolean;
    isActive: boolean;
    hasUnreadMessages: boolean;
    pendingCount: number;
    pendingBlockedCount: number;
    tags: readonly string[];
    allKnownTags: readonly string[];
    tagsEnabled: boolean;
    currentUserId: string | null;
    showServerBadge: boolean;
    compact: boolean;
    compactMinimal: boolean;
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
    activeColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    workingIndicatorMode: 'spinner' | 'pulse';
    /** Retained working placement: show the working indicator without animation. */
    workingIndicatorPaused: boolean;
    hideInactiveSessions: boolean;
}>;
