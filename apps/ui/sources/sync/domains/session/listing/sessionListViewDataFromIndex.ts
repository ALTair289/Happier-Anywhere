import {
    buildSessionListIndexNodeId,
    type SessionListIndexItem,
} from './sessionListIndex';
import type { SessionListViewItem } from './sessionListViewData';

export type BuildSessionListViewDataFromIndexParams = Readonly<{
    index: ReadonlyArray<SessionListIndexItem> | null;
    source: ReadonlyArray<SessionListViewItem> | null;
    sourceIndex: ReadonlyArray<SessionListIndexItem> | null;
}>;

function buildSourceItemsByIndexNodeId(params: BuildSessionListViewDataFromIndexParams): Map<string, SessionListViewItem> {
    const byNodeId = new Map<string, SessionListViewItem>();
    const source = params.source ?? [];
    const sourceIndex = params.sourceIndex ?? [];
    const length = Math.min(source.length, sourceIndex.length);
    for (let index = 0; index < length; index += 1) {
        const sourceItem = source[index];
        const indexItem = sourceIndex[index];
        if (!sourceItem || !indexItem) continue;
        byNodeId.set(buildSessionListIndexNodeId(indexItem), sourceItem);
    }
    return byNodeId;
}

function areNullableValuesEqual<T>(left: T | null | undefined, right: T | null | undefined): boolean {
    return (left ?? null) === (right ?? null);
}

function canReuseHeader(
    item: Extract<SessionListIndexItem, { type: 'header' }>,
    sourceHeader: Extract<SessionListViewItem, { type: 'header' }>,
): boolean {
    return sourceHeader.title === item.title
        && areNullableValuesEqual(sourceHeader.headerKind, item.headerKind)
        && areNullableValuesEqual(sourceHeader.groupKey, item.groupKey)
        && areNullableValuesEqual(sourceHeader.workspaceKey, item.workspaceKey)
        && areNullableValuesEqual(sourceHeader.workspace, item.workspace)
        && areNullableValuesEqual(sourceHeader.folderId, item.folderId)
        && areNullableValuesEqual(sourceHeader.depth, item.folderDepth)
        && areNullableValuesEqual(sourceHeader.workspaceScopeHint, item.workspaceScopeHint)
        && areNullableValuesEqual(sourceHeader.seedSessionId, item.seedSessionId)
        && areNullableValuesEqual(sourceHeader.serverId, item.serverId)
        && areNullableValuesEqual(sourceHeader.serverName, item.serverName)
        && areNullableValuesEqual(sourceHeader.subtitle, item.subtitle)
        && areNullableValuesEqual(sourceHeader.machine, item.machine);
}

function rehydrateHeader(
    item: Extract<SessionListIndexItem, { type: 'header' }>,
    sourceItem: SessionListViewItem | null | undefined,
): Extract<SessionListViewItem, { type: 'header' }> {
    const sourceHeader = sourceItem?.type === 'header' ? sourceItem : null;
    if (sourceHeader && canReuseHeader(item, sourceHeader)) {
        return sourceHeader;
    }
    return {
        ...(sourceHeader ?? { type: 'header' as const, title: item.title }),
        title: item.title,
        headerKind: item.headerKind,
        groupKey: item.groupKey,
        workspaceKey: item.workspaceKey,
        workspace: item.workspace,
        folderId: item.folderId,
        depth: item.folderDepth,
        workspaceScopeHint: item.workspaceScopeHint,
        seedSessionId: item.seedSessionId,
        serverId: item.serverId,
        serverName: item.serverName,
        subtitle: item.subtitle,
        machine: item.machine,
    };
}

function canReuseSession(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    sourceSession: Extract<SessionListViewItem, { type: 'session' }>,
): boolean {
    const keepVisibleWhenInactive = item.keepVisibleWhenInactive === true;
    return (sourceSession.session.keepVisibleWhenInactive === true) === keepVisibleWhenInactive
        && areNullableValuesEqual(sourceSession.section, item.section)
        && areNullableValuesEqual(sourceSession.groupKey, item.groupKey)
        && areNullableValuesEqual(sourceSession.groupKind, item.groupKind)
        && areNullableValuesEqual(sourceSession.folderId, item.folderId)
        && areNullableValuesEqual(sourceSession.folderDepth, item.folderDepth)
        && (sourceSession.pinned === true) === (item.pinned === true)
        && areNullableValuesEqual(sourceSession.attentionPromotionReason, item.attentionPromotionReason)
        && areNullableValuesEqual(sourceSession.workingPlacementReason, item.workingPlacementReason)
        && areNullableValuesEqual(sourceSession.variant, item.variant)
        && areNullableValuesEqual(sourceSession.serverId, item.serverId)
        && areNullableValuesEqual(sourceSession.serverName, item.serverName)
        && areNullableValuesEqual(sourceSession.workspace, item.workspace);
}

function rehydrateSession(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    sourceItem: SessionListViewItem | null | undefined,
): Extract<SessionListViewItem, { type: 'session' }> | null {
    if (sourceItem?.type !== 'session') return null;
    if (canReuseSession(item, sourceItem)) {
        return sourceItem;
    }
    const keepVisibleWhenInactive = item.keepVisibleWhenInactive === true;
    const session = (sourceItem.session.keepVisibleWhenInactive === true) === keepVisibleWhenInactive
        ? sourceItem.session
        : {
            ...sourceItem.session,
            keepVisibleWhenInactive,
        };
    return {
        ...sourceItem,
        session,
        section: item.section,
        groupKey: item.groupKey,
        groupKind: item.groupKind,
        folderId: item.folderId,
        folderDepth: item.folderDepth,
        pinned: item.pinned,
        attentionPromotionReason: item.attentionPromotionReason,
        workingPlacementReason: item.workingPlacementReason,
        variant: item.variant,
        serverId: item.serverId,
        serverName: item.serverName,
        workspace: item.workspace,
    };
}

export function buildSessionListViewDataFromIndex(
    params: BuildSessionListViewDataFromIndexParams,
): SessionListViewItem[] | null {
    if (!params.index) return null;
    if (params.index === params.sourceIndex && params.source) {
        return params.source as SessionListViewItem[];
    }

    const sourceItemsByNodeId = buildSourceItemsByIndexNodeId(params);
    const out: SessionListViewItem[] = [];
    for (const item of params.index) {
        const sourceItem = sourceItemsByNodeId.get(buildSessionListIndexNodeId(item));
        if (item.type === 'header') {
            out.push(rehydrateHeader(item, sourceItem));
            continue;
        }
        const session = rehydrateSession(item, sourceItem);
        if (session) out.push(session);
    }
    return out;
}
