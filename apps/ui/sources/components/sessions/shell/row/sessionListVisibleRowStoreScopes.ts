import { sessionTagKey } from '../sessionTagUtils';

export type SessionListRowStoreSubscriptionScope = Readonly<{
    sessionId: string;
    serverId?: string | null;
}>;

export type SessionListRowStoreSubscriptionMode = 'all-rendered' | 'viewable';

export type SessionListRowStorePriorityReason =
    | 'active'
    | 'attention'
    | 'inProgress'
    | 'pendingPermission'
    | 'pendingUserAction'
    | 'runtimeIssue'
    | 'selected'
    | 'thinking'
    | 'workingPlacement';

export type SessionListRowStorePriorityReasonCounts = Readonly<Partial<Record<SessionListRowStorePriorityReason, number>>>;

const UNKNOWN_VIEWABILITY_EAGER_SUBSCRIPTION_MAX_ROWS = 50;

type SessionListEmbeddedPriorityRowItem = Readonly<{
    attentionPromotionReason?: unknown | null;
    selected?: boolean | null;
    serverId?: string | null;
    session?: Readonly<{
        hasPendingPermissionRequests?: boolean | null;
        hasPendingUserActionRequests?: boolean | null;
        id?: string | null;
        lastRuntimeIssue?: unknown | null;
        latestTurnStatus?: unknown | null;
        thinking?: boolean | null;
    }> | null;
    type: string;
    workingPlacementReason?: string | null;
}>;

export function resolveSessionListRowStoreSubscriptionMode(params: Readonly<{
    nativeAllRenderedMaxRows?: number;
    platformOS: string;
    renderedSessionRows: number;
    webNonVirtualizedMaxRows: number;
}>): SessionListRowStoreSubscriptionMode {
    if (params.platformOS === 'web') {
        return params.renderedSessionRows <= params.webNonVirtualizedMaxRows
            ? 'all-rendered'
            : 'viewable';
    }

    const nativeAllRenderedMaxRows = params.nativeAllRenderedMaxRows;
    if (
        typeof nativeAllRenderedMaxRows === 'number'
        && Number.isFinite(nativeAllRenderedMaxRows)
        && params.renderedSessionRows <= Math.max(0, nativeAllRenderedMaxRows)
    ) {
        return 'all-rendered';
    }

    return 'viewable';
}

export function resolveSessionListRowStoreScopeKey(scope: SessionListRowStoreSubscriptionScope): string {
    const sessionId = String(scope.sessionId ?? '').trim();
    const serverId = typeof scope.serverId === 'string' ? scope.serverId.trim() : '';
    return serverId && sessionId ? sessionTagKey(serverId, sessionId) : sessionId;
}

function isEmbeddedPriorityRowStoreItem(item: SessionListEmbeddedPriorityRowItem): boolean {
    return item.type === 'session'
        && (
            item.workingPlacementReason === 'working'
            || item.selected === true
        );
}

export function buildSessionListEmbeddedPriorityRowKeys(
    items: ReadonlyArray<SessionListEmbeddedPriorityRowItem>,
): ReadonlySet<string> {
    const priorityKeys = new Set<string>();
    for (const item of items) {
        if (!isEmbeddedPriorityRowStoreItem(item)) continue;
        const sessionId = typeof item.session?.id === 'string' ? item.session.id : '';
        const key = resolveSessionListRowStoreScopeKey({
            sessionId,
            serverId: item.serverId ?? null,
        });
        if (key) priorityKeys.add(key);
    }
    return priorityKeys;
}

export function reuseSessionListRowStoreSubscriptionScopes<T extends ReadonlyArray<SessionListRowStoreSubscriptionScope>>(
    previous: T | null | undefined,
    next: T,
): T {
    if (!previous || previous.length !== next.length) return next;
    for (let index = 0; index < next.length; index += 1) {
        const previousScope = previous[index];
        const nextScope = next[index];
        if (!previousScope || !nextScope) return next;
        if (resolveSessionListRowStoreScopeKey(previousScope) !== resolveSessionListRowStoreScopeKey(nextScope)) {
            return next;
        }
    }
    return previous;
}

export function reuseSessionListRowStoreKeySet<T extends ReadonlySet<string>>(
    previous: T | null | undefined,
    next: T,
): T {
    if (!previous || previous.size !== next.size) return next;
    for (const key of next) {
        if (!previous.has(key)) return next;
    }
    return previous;
}

export function resolveSessionListRowStoreSubscriptionScopes(
    scopes: ReadonlyArray<SessionListRowStoreSubscriptionScope>,
    visibleRowKeys: ReadonlySet<string> | null,
    mode: SessionListRowStoreSubscriptionMode = 'viewable',
    priorityRowKeys: ReadonlySet<string> | null = null,
): ReadonlyArray<SessionListRowStoreSubscriptionScope> {
    if (mode === 'all-rendered') return scopes;
    if (visibleRowKeys === null && scopes.length <= UNKNOWN_VIEWABILITY_EAGER_SUBSCRIPTION_MAX_ROWS) return scopes;
    if (scopes.length === 0) return [];
    if (visibleRowKeys === null) {
        if (priorityRowKeys == null || priorityRowKeys.size === 0) return [];
        return scopes.filter((scope) => priorityRowKeys.has(resolveSessionListRowStoreScopeKey(scope)));
    }
    const hasVisibleRows = visibleRowKeys.size > 0;
    const hasPriorityRows = priorityRowKeys != null && priorityRowKeys.size > 0;
    if (!hasVisibleRows && !hasPriorityRows) return [];
    return scopes.filter((scope) => {
        const key = resolveSessionListRowStoreScopeKey(scope);
        return visibleRowKeys.has(key) || priorityRowKeys?.has(key) === true;
    });
}

function readReasonCount(
    counts: SessionListRowStorePriorityReasonCounts | null | undefined,
    reason: SessionListRowStorePriorityReason,
): number {
    const value = counts?.[reason];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function buildSessionListRowStoreSubscriptionTelemetryFields(params: Readonly<{
    dataActive: boolean;
    mode: SessionListRowStoreSubscriptionMode;
    priorityReasonCounts?: SessionListRowStorePriorityReasonCounts | null;
    priorityRowKeys?: ReadonlySet<string> | null;
    subscribedScopes: ReadonlyArray<SessionListRowStoreSubscriptionScope>;
    totalScopes: ReadonlyArray<SessionListRowStoreSubscriptionScope>;
    visibleRowKeys: ReadonlySet<string> | null;
}>): Record<string, number> {
    const priorityRowKeys = params.priorityRowKeys ?? null;
    const subscribedPriorityRows = priorityRowKeys
        ? params.subscribedScopes.reduce((count, scope) => (
            priorityRowKeys.has(resolveSessionListRowStoreScopeKey(scope)) ? count + 1 : count
        ), 0)
        : 0;

    return {
        allRenderedMode: params.mode === 'all-rendered' ? 1 : 0,
        dataActive: params.dataActive ? 1 : 0,
        priorityActiveRows: readReasonCount(params.priorityReasonCounts, 'active'),
        priorityAttentionRows: readReasonCount(params.priorityReasonCounts, 'attention'),
        priorityInProgressRows: readReasonCount(params.priorityReasonCounts, 'inProgress'),
        priorityPendingPermissionRows: readReasonCount(params.priorityReasonCounts, 'pendingPermission'),
        priorityPendingUserActionRows: readReasonCount(params.priorityReasonCounts, 'pendingUserAction'),
        priorityRows: priorityRowKeys?.size ?? 0,
        priorityRuntimeIssueRows: readReasonCount(params.priorityReasonCounts, 'runtimeIssue'),
        prioritySelectedRows: readReasonCount(params.priorityReasonCounts, 'selected'),
        prioritySubscribedRows: subscribedPriorityRows,
        priorityThinkingRows: readReasonCount(params.priorityReasonCounts, 'thinking'),
        priorityWorkingPlacementRows: readReasonCount(params.priorityReasonCounts, 'workingPlacement'),
        subscribedRows: params.subscribedScopes.length,
        totalRows: params.totalScopes.length,
        viewabilityKnown: params.visibleRowKeys === null ? 0 : 1,
        viewableMode: params.mode === 'viewable' ? 1 : 0,
        visibleRows: params.visibleRowKeys?.size ?? 0,
    };
}
