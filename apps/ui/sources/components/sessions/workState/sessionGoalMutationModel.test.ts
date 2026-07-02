import { describe, expect, it } from 'vitest';

import { goalSignature, isNoOpGoalMutation } from './sessionGoalMutationModel';
import type { SessionWorkStateItem } from './sessionWorkStateTypes';

function goal(partial: Partial<SessionWorkStateItem> & Pick<SessionWorkStateItem, 'status'>): SessionWorkStateItem {
    return {
        id: 'goal:claude',
        kind: 'goal',
        origin: 'vendor',
        title: 'Ship goals',
        updatedAt: 10,
        ...partial,
    };
}

describe('goalSignature', () => {
    it('changes when any salient field changes and is empty for no goal', () => {
        expect(goalSignature(null)).toBe('');
        const base = goal({ status: 'active' });
        expect(goalSignature(base)).toBe(goalSignature(goal({ status: 'active' })));
        expect(goalSignature(base)).not.toBe(goalSignature(goal({ status: 'paused' })));
        expect(goalSignature(base)).not.toBe(goalSignature(goal({ status: 'active', title: 'New title' })));
        expect(goalSignature(base)).not.toBe(goalSignature(goal({ status: 'active', updatedAt: 11 })));
    });
});

describe('isNoOpGoalMutation', () => {
    it('treats an identical-objective active request as a no-op (does not strand pending)', () => {
        expect(isNoOpGoalMutation(goal({ status: 'active' }), { objective: '  Ship goals  ' })).toBe(true);
    });

    it('is not a no-op when the objective changes, the status transitions, or a budget is set', () => {
        const active = goal({ status: 'active' });
        expect(isNoOpGoalMutation(active, { objective: 'Different' })).toBe(false);
        expect(isNoOpGoalMutation(active, { objective: 'Ship goals', status: 'paused' })).toBe(false);
        expect(isNoOpGoalMutation(active, { tokenBudget: 1000 })).toBe(false);
    });

    it('treats a same-status-only request as a no-op and a different-status request as a change', () => {
        expect(isNoOpGoalMutation(goal({ status: 'paused' }), { status: 'paused' })).toBe(true);
        expect(isNoOpGoalMutation(goal({ status: 'paused' }), { status: 'active' })).toBe(false);
    });

    it('is never a no-op when there is no existing goal', () => {
        expect(isNoOpGoalMutation(null, { objective: 'Ship goals' })).toBe(false);
    });
});
