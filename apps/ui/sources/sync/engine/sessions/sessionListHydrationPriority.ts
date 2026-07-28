export type SessionListHydrationPriorityReason = 'required' | 'route' | 'active' | 'priority' | 'eager' | 'background';

export type SessionListHydrationPriorityCounts = Record<SessionListHydrationPriorityReason, number> & {
    skippedBackground: number;
};

type SessionListHydrationPriorityRow = Readonly<{
    id: string;
    active?: boolean;
}>;

type SessionListAttentionHydrationPriorityRow = Readonly<{
    pendingPermissionRequestCount?: number | null;
    pendingUserActionRequestCount?: number | null;
    latestTurnStatus?: string | null;
    lastRuntimeIssue?: unknown;
    latestReadyEventSeq?: number | null;
    lastViewedSessionSeq?: number | null;
}>;

export function isSessionListRowAttentionHydrationPriority(
    row: SessionListAttentionHydrationPriorityRow,
): boolean {
    if ((row.pendingPermissionRequestCount ?? 0) > 0 || (row.pendingUserActionRequestCount ?? 0) > 0) {
        return true;
    }
    if (row.latestTurnStatus === 'failed' && row.lastRuntimeIssue != null) {
        return true;
    }
    const latestReadyEventSeq = normalizeSessionListPrioritySeq(row.latestReadyEventSeq);
    return latestReadyEventSeq !== null
        && latestReadyEventSeq > (normalizeSessionListPrioritySeq(row.lastViewedSessionSeq) ?? 0);
}

function normalizeSessionListPrioritySeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

type SessionListHydrationPriorityParams<Row extends SessionListHydrationPriorityRow> = Readonly<{
    rows: readonly Row[];
    requiredSessionIds?: ReadonlySet<string> | readonly string[];
    routeSessionIds?: readonly string[];
    activeSessionIds?: ReadonlySet<string> | readonly string[];
    prioritySessionIds?: ReadonlySet<string> | readonly string[];
    eagerHydrationCount?: number;
    maxBackgroundHydrationRows?: number;
}>;

export type OrderedSessionListHydrationRows<Row extends SessionListHydrationPriorityRow> = Readonly<{
    rows: Row[];
    counts: SessionListHydrationPriorityCounts;
    reasonById: ReadonlyMap<string, SessionListHydrationPriorityReason>;
}>;

export function normalizeSessionListHydrationSessionIds(
    values: ReadonlySet<string> | readonly string[] | undefined,
): string[] {
    if (!values) return [];
    const rawValues = Array.isArray(values) ? values : Array.from(values);
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const value of rawValues) {
        const id = String(value ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function appendRowsById<Row extends SessionListHydrationPriorityRow>(params: Readonly<{
    ids: readonly string[];
    reason: SessionListHydrationPriorityReason;
    reasonById: Map<string, SessionListHydrationPriorityReason>;
    rowById: ReadonlyMap<string, Row>;
    assignedIds: Set<string>;
    out: Row[];
}>): number {
    let added = 0;
    for (const id of params.ids) {
        if (params.assignedIds.has(id)) continue;
        const row = params.rowById.get(id);
        if (!row) continue;
        params.assignedIds.add(id);
        params.reasonById.set(row.id, params.reason);
        params.out.push(row);
        added += 1;
    }
    return added;
}

export function orderRowsForSessionListHydration<Row extends SessionListHydrationPriorityRow>(
    params: SessionListHydrationPriorityParams<Row>,
): OrderedSessionListHydrationRows<Row> {
    const counts: SessionListHydrationPriorityCounts = {
        required: 0,
        route: 0,
        active: 0,
        priority: 0,
        eager: 0,
        background: 0,
        skippedBackground: 0,
    };
    const rowById = new Map(params.rows.map((row) => [row.id, row]));
    const assignedIds = new Set<string>();
    const reasonById = new Map<string, SessionListHydrationPriorityReason>();
    const orderedRows: Row[] = [];
    counts.required = appendRowsById({
        ids: normalizeSessionListHydrationSessionIds(params.requiredSessionIds),
        reason: 'required',
        reasonById,
        rowById,
        assignedIds,
        out: orderedRows,
    });
    counts.route = appendRowsById({
        ids: normalizeSessionListHydrationSessionIds(params.routeSessionIds),
        reason: 'route',
        reasonById,
        rowById,
        assignedIds,
        out: orderedRows,
    });
    counts.active = appendRowsById({
        ids: normalizeSessionListHydrationSessionIds(params.activeSessionIds),
        reason: 'active',
        reasonById,
        rowById,
        assignedIds,
        out: orderedRows,
    });
    counts.priority = appendRowsById({
        ids: normalizeSessionListHydrationSessionIds(params.prioritySessionIds),
        reason: 'priority',
        reasonById,
        rowById,
        assignedIds,
        out: orderedRows,
    });

    for (const row of params.rows) {
        if (!row.active || assignedIds.has(row.id)) continue;
        assignedIds.add(row.id);
        reasonById.set(row.id, 'active');
        orderedRows.push(row);
        counts.active += 1;
    }

    const eagerHydrationCount = Math.max(0, Math.trunc(params.eagerHydrationCount ?? 0));
    const maxBackgroundHydrationRows = params.maxBackgroundHydrationRows === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.trunc(params.maxBackgroundHydrationRows));
    for (const row of params.rows) {
        if (assignedIds.has(row.id)) continue;
        if (counts.eager < eagerHydrationCount) {
            assignedIds.add(row.id);
            reasonById.set(row.id, 'eager');
            orderedRows.push(row);
            counts.eager += 1;
            continue;
        }
        if (counts.background < maxBackgroundHydrationRows) {
            assignedIds.add(row.id);
            reasonById.set(row.id, 'background');
            orderedRows.push(row);
            counts.background += 1;
        } else {
            counts.skippedBackground += 1;
        }
    }

    return { rows: orderedRows, counts, reasonById };
}
