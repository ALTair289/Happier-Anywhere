import { isClaudeSlashCommandSupported } from '@happier-dev/protocol';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function readClaudeGoalWorkStateItem(metadata: unknown): Record<string, unknown> | null {
    const snapshot = asRecord(asRecord(metadata)?.sessionWorkStateV1);
    if (!snapshot || snapshot.v !== 1) return null;
    if (!Array.isArray(snapshot.items)) return null;
    for (const item of snapshot.items) {
        const record = asRecord(item);
        if (record?.kind === 'goal') return record;
    }
    return null;
}

/**
 * Capability-driven goal-edit gate for Claude (mirrors the provider-derived approach used for
 * Codex). The Claude work-state source publishes a `kind:'goal'` item carrying
 * `goalCapabilities.canEdit` once it observes native `goal_status`/`/goal` support, so the gate
 * reads that capability rather than branching on `agentId`.
 *
 * NOTE: This signal only exists once a goal item has been derived from a native `goal_status`
 * attachment. It is NOT sufficient on its own to decide whether a session can SET its first goal —
 * see `claudeGoalCommandSupported` for the session-level capability that drives the chip entry point.
 */
export function claudeGoalEditCapabilityPresent(metadata: unknown): boolean {
    const goal = readClaudeGoalWorkStateItem(metadata);
    if (!goal) return false;
    const capabilities = asRecord(goal.goalCapabilities);
    return capabilities?.canEdit === true;
}

/**
 * Session-level `/goal` capability for Claude, derived from the runtime-published
 * `metadata.slashCommands` list (Claude system-init `slash_commands`, published to session metadata
 * on every Claude launcher path: SDK probe + unified-terminal `onCapabilities`). This is the signal
 * that lets the goal chip surface so a user can SET their first goal — independent of any existing
 * goal item (which only appears after a native `goal_status` attachment, never emitted on the
 * agent-SDK path). Mirrors how the Codex gate derives editability from runtime identity rather than
 * from an already-present goal. Fail-closed: absent/unknown commands → false.
 */
export function claudeGoalCommandSupported(metadata: unknown): boolean {
    // `goal`/`/goal` shape parity is owned by the shared protocol helper (fail-closed on a
    // missing/non-array list), so the CLI source gate and this UI gate cannot drift.
    return isClaudeSlashCommandSupported(asRecord(metadata)?.slashCommands, 'goal');
}

export function claudeSupportsEditableGoals(ctx: Readonly<{
    agentId: string;
    session: Readonly<{ active?: boolean; metadata?: unknown }>;
}>): boolean {
    if (ctx.agentId !== 'claude') return false;
    const metadata = ctx.session.metadata ?? null;
    // Two capability signals, both provider-derived (no `agentId` branching beyond the Claude gate):
    //  1. Session-level `/goal` support from `metadata.slashCommands` — present BEFORE any goal is
    //     set, so the chip can be the first-goal entry point. Requires an active session because the
    //     `/goal` command is injected live; inactive sessions seed through the goal-item path below.
    //  2. A goal item already advertising `goalCapabilities.canEdit` — covers a resumable (detached)
    //     session restored from metadata that carries a prior goal, even while `slashCommands` is not
    //     re-published.
    if (ctx.session.active === true && claudeGoalCommandSupported(metadata)) return true;
    return claudeGoalEditCapabilityPresent(metadata);
}

/**
 * Claude's goal-action capability profile (edit + clear only; no pause/resume/complete, no token
 * budget). Used as the fallback control surface for the "Set goal" form before a native
 * `goal_status` item exists, so the Codex-only budget/lifecycle controls never appear on a Claude
 * session. Mirrors the `{ canEdit, canClear }` capabilities the Claude work-state source attaches to
 * a goal item once one exists. Returns null when the session is not goal-editable so the gate
 * (`claudeSupportsEditableGoals`) remains the single source of truth for visibility.
 */
export function claudeGoalActionCapabilityProfile(ctx: Readonly<{
    agentId: string;
    session: Readonly<{ active?: boolean; metadata?: unknown }>;
}>): Readonly<{ canEdit: boolean; canStop: boolean; canClear: boolean; canConfigureBudget: boolean }> | null {
    if (!claudeSupportsEditableGoals(ctx)) return null;
    return { canEdit: true, canStop: false, canClear: true, canConfigureBudget: false };
}
