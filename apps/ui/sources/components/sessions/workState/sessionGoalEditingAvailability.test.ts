import { describe, expect, it } from 'vitest';

import { isSessionGoalEditingAvailable } from './sessionGoalEditingAvailability';

describe('isSessionGoalEditingAvailable', () => {
    it('requires provider support, the goals feature gate, AND session write access', () => {
        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: true,
            goalsFeatureEnabled: true,
            hasWriteAccess: true,
        })).toBe(true);

        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: true,
            goalsFeatureEnabled: false,
            hasWriteAccess: true,
        })).toBe(false);

        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: false,
            goalsFeatureEnabled: true,
            hasWriteAccess: true,
        })).toBe(false);
    });

    it('blocks goal mutation on a view-only (read-only) session even when the provider supports goals (G5)', () => {
        // A view-only session may still DISPLAY goal/work-state, but it must never expose enabled
        // set/clear controls. Editability now requires write access in addition to provider support.
        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: true,
            goalsFeatureEnabled: true,
            hasWriteAccess: false,
        })).toBe(false);
    });
});
