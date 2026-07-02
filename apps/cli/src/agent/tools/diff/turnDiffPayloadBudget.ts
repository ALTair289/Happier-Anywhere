const DEFAULT_TURN_DIFF_FILE_BUDGET_BYTES = 256 * 1024;
const DEFAULT_TURN_DIFF_TURN_BUDGET_BYTES = 1024 * 1024;

function resolveNonNegativeIntEnv(input: unknown, fallback: number): number {
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return Math.trunc(input);
    const raw = (input ?? '').toString().trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.trunc(parsed);
}

/**
 * Per-file byte budget for inline turn-diff content (old/new text pair or unified diff).
 * Files above the budget are diff-ified locally; if even the diff exceeds the budget the file
 * degrades to a truncated placeholder with stats. `0` disables the per-file bound.
 */
export function resolveTurnDiffFileBudgetBytes(input?: unknown): number {
    return resolveNonNegativeIntEnv(
        input ?? process.env.HAPPIER_TURN_DIFF_FILE_BUDGET_BYTES,
        DEFAULT_TURN_DIFF_FILE_BUDGET_BYTES,
    );
}

/**
 * Total byte budget for one turn's Diff tool payload across all files. Once exhausted, remaining
 * files degrade to truncated placeholders with stats. `0` disables the per-turn bound.
 */
export function resolveTurnDiffTurnBudgetBytes(input?: unknown): number {
    return resolveNonNegativeIntEnv(
        input ?? process.env.HAPPIER_TURN_DIFF_TURN_BUDGET_BYTES,
        DEFAULT_TURN_DIFF_TURN_BUDGET_BYTES,
    );
}
