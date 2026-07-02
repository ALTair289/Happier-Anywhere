import { describe, expect, it } from 'vitest';

import { resolveGoalActionCapabilities } from './goalActionVisibility';
import type { SessionWorkStateItem } from './sessionWorkStateTypes';

function goal(overrides: Partial<SessionWorkStateItem> = {}): SessionWorkStateItem {
    return {
        id: 'goal:1',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'Ship goals',
        updatedAt: 10,
        ...overrides,
    };
}

describe('resolveGoalActionCapabilities', () => {
    it('grants the full control surface when no capabilities are present (Codex legacy)', () => {
        expect(resolveGoalActionCapabilities(goal())).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
    });

    it('grants the full control surface when there is no goal and no fallback profile', () => {
        expect(resolveGoalActionCapabilities(null)).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
    });

    it('applies the provider fallback profile when there is no goal item yet (set-first-goal form)', () => {
        // Claude's profile: edit/clear only, no pause/resume/complete, no budget. This is the
        // capability used by the "Set goal" form before any goal_status-derived item exists, so the
        // Codex-only budget UI does not leak onto a fresh Claude session.
        expect(resolveGoalActionCapabilities(null, { canEdit: true, canStop: false, canClear: true, canConfigureBudget: false })).toEqual({
            canEdit: true,
            canStop: false,
            canClear: true,
            canConfigureBudget: false,
        });
    });

    it('prefers the goal item capabilities over the fallback profile when a goal item is present', () => {
        // A goal item that advertises full caps wins even if a restrictive fallback is supplied.
        expect(resolveGoalActionCapabilities(
            goal({ goalCapabilities: { canEdit: true, canStop: true, canClear: true } }),
            { canEdit: true, canStop: false, canClear: true, canConfigureBudget: false },
        )).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
    });

    it('exposes only edit and clear for Claude capabilities ({ canEdit, canClear })', () => {
        expect(resolveGoalActionCapabilities(goal({ goalCapabilities: { canEdit: true, canClear: true } }))).toEqual({
            canEdit: true,
            canStop: false,
            canClear: true,
            canConfigureBudget: false,
        });
    });

    it('ties pause/resume/complete and the token budget to canStop when capabilities are present', () => {
        const caps = resolveGoalActionCapabilities(goal({ goalCapabilities: { canEdit: true, canStop: true, canClear: true } }));
        expect(caps.canStop).toBe(true);
        expect(caps.canConfigureBudget).toBe(true);
    });

    it('treats an empty capabilities object as no declared controls', () => {
        expect(resolveGoalActionCapabilities(goal({ goalCapabilities: {} }))).toEqual({
            canEdit: false,
            canStop: false,
            canClear: false,
            canConfigureBudget: false,
        });
    });
});
