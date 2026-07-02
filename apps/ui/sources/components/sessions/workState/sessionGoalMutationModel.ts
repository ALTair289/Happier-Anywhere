import type { SessionWorkStateItem } from './sessionWorkStateTypes';

/**
 * Pure goal-mutation model (G6): request/result contracts plus the value-stable goal signature and
 * the no-op detection used by the goal controller. Extracted from the React hook so the mutation
 * rules can be tested without rendering the popover, and so the chip/popover/content surfaces share
 * exactly one definition.
 */

export type SessionWorkStateGoalOperationResult = { ok: true } | { ok: false; error: string };

export type SessionWorkStateGoalSetRequest = Readonly<{
    objective?: string;
    status?: 'active' | 'paused' | 'complete';
    tokenBudget?: number | null;
    resumeInactiveWithInitialGoal?: boolean;
}>;

/**
 * After the goal RPC is acknowledged we keep the popover in a "setting goal…" pending state until
 * the native work-state actually reflects the change (H4). For Claude the confirmation only arrives
 * once a fresh `goal_status` work-state item lands; if it never does within this window we surface a
 * diagnostic instead of silently leaving a decorative/unconfirmed goal.
 */
export const GOAL_CONFIRMATION_TIMEOUT_MS = 12_000;

/**
 * A value-stable signature of the goal item used to detect that the work-state confirmed a mutation.
 * Any change (new goal, title, status, status-reason, or a fresh `updatedAt`) counts as confirmation.
 */
export function goalSignature(goal: SessionWorkStateItem | null): string {
    if (!goal) return '';
    return `${goal.id}|${goal.title}|${goal.status}|${goal.statusReason ?? ''}|${goal.updatedAt}`;
}

/**
 * Whether a set request would leave the goal unchanged. A no-op never produces a fresh native
 * work-state item, so the source's no-churn dedupe suppresses the republish and the confirmation
 * effect would otherwise wait the full timeout. We detect "no change needed" up front and treat
 * the acknowledged mutation as immediate success instead of pending (suspected-(a) fix).
 */
export function isNoOpGoalMutation(goal: SessionWorkStateItem | null, request: SessionWorkStateGoalSetRequest): boolean {
    if (!goal) return false;
    // A budget change always mutates the goal.
    if (request.tokenBudget !== undefined) return false;
    if (request.objective !== undefined) {
        if (request.objective.trim() !== goal.title.trim()) return false;
        // The objective matches; only a no-op if no status transition is requested.
        return request.status === undefined || request.status === goal.status;
    }
    // Status-only request (pause/resume/complete): no-op when already in that status.
    if (request.status !== undefined) return request.status === goal.status;
    return true;
}
