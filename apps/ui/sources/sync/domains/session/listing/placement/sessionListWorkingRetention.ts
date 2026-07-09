import type { SessionListRenderableSession } from '../sessionListRenderable';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '../../attention/deriveSessionRuntimePresentationState';

export const SESSION_LIST_WORKING_RETENTION_LIMIT_MS = 12 * 60 * 60 * 1000;

export type SessionListWorkingRetentionKeySource = ReadonlySet<string> | ReadonlyArray<string> | null | undefined;

export function normalizeSessionListPlacementKey(serverIdRaw: unknown, sessionIdRaw: unknown): string | null {
    const serverId = typeof serverIdRaw === 'string' ? serverIdRaw.trim() : '';
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
    if (!serverId || !sessionId) return null;
    return `${serverId}:${sessionId}`;
}

export function normalizeSessionListWorkingRetentionKeys(
    retained: SessionListWorkingRetentionKeySource,
): ReadonlySet<string> {
    if (!retained) return new Set();
    if (retained instanceof Set) return retained;
    return new Set(retained);
}

export function shouldRetainSessionListWorkingPlacement(params: Readonly<{
    session: SessionListRenderableSession;
    sessionKey: string | null;
    retainedKeys: ReadonlySet<string>;
    nowMs: number;
    retentionLimitMs?: number;
}>): boolean {
    if (!params.sessionKey || !params.retainedKeys.has(params.sessionKey)) return false;
    if (!isRetainableWorkingSession(params.session)) return false;
    if (
        params.session.thinking === false
        && isFreshTimestamp(params.session.activeAt, params.nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
    ) {
        return false;
    }
    const retentionAnchor = resolveWorkingRetentionAnchor(params.session);
    if (retentionAnchor === null) return false;
    const retentionLimitMs = params.retentionLimitMs ?? SESSION_LIST_WORKING_RETENTION_LIMIT_MS;
    return retentionAnchor + retentionLimitMs > params.nowMs;
}

function isRetainableWorkingSession(session: SessionListRenderableSession): boolean {
    if (session.archivedAt != null) return false;
    if (session.active !== true) return false;
    if (session.presence !== 'online') return false;
    return session.latestTurnStatus === 'in_progress';
}

/**
 * Whether the inputs that decide working RETENTION changed between two
 * renderables. This comparator lives with `shouldRetainSessionListWorkingPlacement`
 * and `resolveWorkingRetentionAnchor` on purpose: it must cover exactly the
 * fields those functions read (retention gate: `thinking` + fresh `activeAt`;
 * anchor: the four timestamps below), so a new retention signal cannot be
 * added without updating this comparison in the same file.
 */
export function didSessionListWorkingRetentionInputsChange(
    previous: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    return (previous.thinking === true) !== (next.thinking === true)
        || (previous.activeAt ?? null) !== (next.activeAt ?? null)
        || (previous.thinkingAt ?? null) !== (next.thinkingAt ?? null)
        || (previous.optimisticThinkingAt ?? null) !== (next.optimisticThinkingAt ?? null)
        || (previous.latestTurnStatusObservedAt ?? null) !== (next.latestTurnStatusObservedAt ?? null);
}

function isFreshTimestamp(value: number | null | undefined, nowMs: number, budgetMs: number): boolean {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value > 0
        && value + budgetMs > nowMs;
}

function resolveWorkingRetentionAnchor(session: SessionListRenderableSession): number | null {
    return maxNormalizedTimestamp([
        session.latestTurnStatusObservedAt,
        session.thinkingAt,
        session.activeAt,
        session.optimisticThinkingAt,
    ]);
}

function maxNormalizedTimestamp(values: ReadonlyArray<number | null | undefined>): number | null {
    let max: number | null = null;
    for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        const normalized = Math.trunc(value);
        max = max === null ? normalized : Math.max(max, normalized);
    }
    return max;
}
