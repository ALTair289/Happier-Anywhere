import React from 'react';
import { Platform } from 'react-native';

import { storage } from '@/sync/domains/state/storage';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import {
    createSessionListRowStoreStateSelector,
    selectSessionListRowStateSnapshot,
} from '@/sync/store/sessionListRowStateSnapshot';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from '../SessionListHeaderFrame';
import type {
    UseSessionInlineDragCancelEvent,
    UseSessionInlineDragDropResultEvent,
    UseSessionInlineDragResolveDropResultEvent,
    UseSessionInlineDragResolvedDrop,
} from '../useSessionInlineDrag';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { useSessionListRelativeTimeClock } from './useSessionListRelativeTimeClock';
import {
    buildCachedSessionListRowModel,
    createSessionListRowModelsCache,
    resolveSessionListRowModelAdjacency,
} from './buildSessionListRowModels';
import { SessionListRow } from './SessionListRow';
import type {
    SessionListRowPresentationSettings,
    SessionListRowSessionItem,
    SessionListRowStoreState,
} from './sessionListRowModelTypes';
import type { SessionListRowStoreSubscriptionMode } from './sessionListVisibleRowStoreScopes';

const EMPTY_SESSION_LIST_ROW_STORE_STATE: SessionListRowStoreState = Object.freeze({});
const EMPTY_FOLDER_MOVE_MENU_ITEMS: readonly DropdownMenuItem[] = Object.freeze([]);

type SessionListRowMoveActionHandlers = Readonly<{
    onMoveDown?: () => void;
    onMoveToFolder?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onSelectFolderMoveMenuItem?: (itemId: string) => void;
}>;

export type SessionListRowModelBoundaryProps = Readonly<{
    activeServerId?: string | null;
    dataActive: boolean;
    dataIndex: number;
    dragEnabled: boolean;
    draggingSessionKey: string | null;
    folderMoveMenuItems?: readonly DropdownMenuItem[];
    folderViewEnabled: boolean;
    getRowMoveActionHandlers: (input: Readonly<{
        item: SessionListRowSessionItem;
        sourceLabel: string;
        sourceRowId: string;
    }>) => SessionListRowMoveActionHandlers;
    getRowNativeContextMenuOpenChangeHandler: (sessionKey: string) => (next: boolean) => void;
    getRowSetTagsHandler: (sessionKey: string) => (newTags: string[]) => void;
    getRowTogglePinnedHandler: (sessionKey: string) => () => void;
    groupKey: string;
    item: SessionListRowSessionItem;
    items: ReadonlyArray<SessionListViewItem>;
    nativeContextMenuSessionKey: string | null;
    onDragCancel: (event: UseSessionInlineDragCancelEvent) => void;
    onDragStart: (sessionKey: string) => void;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    overlayShared: TreeDropOverlaySharedValues;
    prioritySessionRowKeys: ReadonlySet<string>;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    rowStoreSubscriptionEnabled: boolean;
    rowStoreSubscriptionMode: SessionListRowStoreSubscriptionMode;
    settings: SessionListRowPresentationSettings;
    viewableSessionRowKeys: ReadonlySet<string> | null;
}>;

export const SessionListRowModelBoundary = React.memo(function SessionListRowModelBoundary(
    props: SessionListRowModelBoundaryProps,
) {
    if (!props.rowStoreSubscriptionEnabled) {
        return (
            <SessionListRowModelBoundaryContent
                {...props}
                rowStoreState={EMPTY_SESSION_LIST_ROW_STORE_STATE}
            />
        );
    }

    return <SubscribedSessionListRowModelBoundary {...props} />;
});

const SubscribedSessionListRowModelBoundary = React.memo(function SubscribedSessionListRowModelBoundary(
    props: SessionListRowModelBoundaryProps,
) {
    const rowStoreScope = React.useMemo(() => [{
        sessionId: props.item.session.id,
        serverId: props.item.serverId ?? null,
    }], [props.item.serverId, props.item.session.id]);
    const rowStoreStateSelector = React.useMemo(
        () => createSessionListRowStoreStateSelector(rowStoreScope, props.activeServerId),
        [props.activeServerId, rowStoreScope],
    );
    const liveRowStoreState = storage(rowStoreStateSelector);
    const frozenRowStoreStateRef = React.useRef<SessionListRowStoreState>(EMPTY_SESSION_LIST_ROW_STORE_STATE);
    if (props.dataActive) {
        frozenRowStoreStateRef.current = liveRowStoreState;
    }
    const rowStoreState = props.dataActive
        ? liveRowStoreState
        : frozenRowStoreStateRef.current;

    return (
        <SessionListRowModelBoundaryContent
            {...props}
            rowStoreState={rowStoreState}
        />
    );
});

type SessionListRowModelBoundaryContentProps = SessionListRowModelBoundaryProps & Readonly<{
    rowStoreState: SessionListRowStoreState;
}>;

const SessionListRowModelBoundaryContent = React.memo(function SessionListRowModelBoundaryContent(
    props: SessionListRowModelBoundaryContentProps,
) {
    const relativeNowMs = useSessionListRelativeTimeClock(props.dataActive);
    // The row reads the SAME shared runtime clock as group placement
    // (useVisibleSessionListRuntimeNowMs), so the working indicator and the
    // session's group can never cross a freshness boundary in different
    // render cycles. The row only contributes its own wake horizon (below,
    // straight from the freshly built row model), which can be earlier than
    // the list's when its renderable is fresher than the committed view data.
    const runtimeNowMs = useSessionListRuntimeNowMs(props.dataActive);
    const settings = React.useMemo<SessionListRowPresentationSettings>(() => ({
        ...props.settings,
        relativeNowMs,
        runtimeNowMs,
    }), [props.settings, relativeNowMs, runtimeNowMs]);
    const rowModelsCacheRef = React.useRef(createSessionListRowModelsCache());
    const snapshot = selectSessionListRowStateSnapshot(props.rowStoreState, {
        sessionId: props.item.session.id,
        serverId: props.item.serverId,
    });
    const adjacency = React.useMemo(
        () => resolveSessionListRowModelAdjacency(props.items, props.dataIndex),
        [props.dataIndex, props.items],
    );
    const rowModel = React.useMemo(() => buildCachedSessionListRowModel({
        item: props.item,
        snapshot,
        dataIndex: props.dataIndex,
        adjacency,
        settings,
        cache: rowModelsCacheRef.current,
    }), [adjacency, props.dataIndex, props.item, settings, snapshot]);

    useSessionListRuntimeWake(rowModel.nextRuntimeFreshnessAtMs, props.dataActive);

    const sessionKey = rowModel.rowKey || null;
    const rowAttentionAnimationEnabled = props.rowStoreSubscriptionMode === 'all-rendered'
        || props.viewableSessionRowKeys === null
        || sessionKey === null
        || props.viewableSessionRowKeys.has(sessionKey)
        || props.prioritySessionRowKeys.has(sessionKey);
    const supportsPin = Boolean(sessionKey);
    const onTogglePinned = supportsPin && sessionKey
        ? props.getRowTogglePinnedHandler(sessionKey)
        : null;
    const onSetTags = sessionKey
        ? props.getRowSetTagsHandler(sessionKey)
        : null;
    const isIos = Platform.OS === 'ios';
    const nativeContextMenuOpen = isIos && sessionKey != null && props.nativeContextMenuSessionKey === sessionKey;
    const handleNativeContextMenuOpenChange = isIos && sessionKey
        ? props.getRowNativeContextMenuOpenChangeHandler(sessionKey)
        : null;
    const moveActionHandlers = props.getRowMoveActionHandlers({
        sourceRowId: rowModel.treeRowId,
        sourceLabel: props.item.session.id,
        item: props.item,
    });

    return (
        <SessionListRow
            sessionKey={sessionKey}
            treeRowId={rowModel.treeRowId}
            groupKey={props.groupKey}
            onDragStart={props.onDragStart}
            onDropResult={props.onDropResult}
            onDragCancel={props.onDragCancel}
            resolveDropResult={props.resolveDropResult}
            onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
            onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            isDragActive={props.draggingSessionKey != null}
            isBeingDragged={sessionKey != null && sessionKey === props.draggingSessionKey}
            dragEnabled={props.dragEnabled}
            dataIndex={props.dataIndex}
            overlayShared={props.overlayShared}
            rowModel={rowModel}
            session={rowModel.session}
            subtitleOverride={rowModel.subtitle ?? null}
            subtitleEllipsizeMode={rowModel.subtitleEllipsizeMode}
            serverId={rowModel.serverId ?? undefined}
            serverName={rowModel.serverName}
            currentUserId={rowModel.currentUserId}
            showServerBadge={rowModel.showServerBadge}
            pinned={rowModel.isPinned}
            onTogglePinned={onTogglePinned}
            tags={rowModel.tags}
            allKnownTags={rowModel.allKnownTags}
            onSetTags={onSetTags}
            tagsEnabled={rowModel.tagsEnabled}
            selected={rowModel.isSelected}
            isFirst={rowModel.adjacency.isFirst}
            isLast={rowModel.adjacency.isLast}
            isSingle={rowModel.adjacency.isSingle}
            variant={rowModel.variant ?? undefined}
            activityTimeMode={rowModel.activity.mode === 'updatedAt' ? 'updatedAt' : undefined}
            folderDepth={rowModel.folder.depth}
            folderMoveMenuItems={props.folderViewEnabled ? props.folderMoveMenuItems ?? EMPTY_FOLDER_MOVE_MENU_ITEMS : EMPTY_FOLDER_MOVE_MENU_ITEMS}
            onMoveToFolder={props.folderViewEnabled ? moveActionHandlers.onMoveToFolder : undefined}
            onMoveToWorkspaceRoot={props.folderViewEnabled ? moveActionHandlers.onMoveToWorkspaceRoot : undefined}
            onMoveUp={props.folderViewEnabled ? moveActionHandlers.onMoveUp : undefined}
            onMoveDown={props.folderViewEnabled ? moveActionHandlers.onMoveDown : undefined}
            onSelectFolderMoveMenuItem={moveActionHandlers.onSelectFolderMoveMenuItem}
            secondaryLineMode={rowModel.secondaryLineMode}
            compact={rowModel.compact}
            compactMinimal={rowModel.compactMinimal}
            rowAttentionAnimationEnabled={rowAttentionAnimationEnabled}
            {...(isIos && sessionKey != null && props.dragEnabled
                ? {
                    nativeInlineDragEnabled: true,
                }
                : null)}
            {...(isIos && sessionKey != null
                ? {
                    nativeContextMenuOpen,
                    onNativeContextMenuOpenChange: handleNativeContextMenuOpenChange ?? undefined,
                }
                : null)}
        />
    );
});
