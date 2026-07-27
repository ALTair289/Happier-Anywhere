import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    ROW_ACTION_REVEAL_SLOT_COST_ROW_COUNT,
    installRowActionRevealSlotCostMatchMedia,
    renderRowActionRevealSlotRows,
} from './RowActionRevealSlot.testHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({ os: 'ios' }));
const costState = vi.hoisted(() => ({
    animatedValues: 0,
    timings: 0,
    changeListeners: [] as Array<(event: { matches: boolean }) => void>,
}));

vi.mock('react-native', async () => {
    const { createRowActionRevealSlotCostReactNativeMock } = await import('./RowActionRevealSlot.testHelpers');
    return createRowActionRevealSlotCostReactNativeMock(costState, platformState);
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('RowActionRevealSlot cost on touch platforms', () => {
    afterEach(() => {
        standardCleanup();
        costState.animatedValues = 0;
        costState.timings = 0;
        costState.changeListeners.length = 0;
    });

    it('costs nothing per row where the reveal policy is constant-true', async () => {
        const restoreWindow = installRowActionRevealSlotCostMatchMedia(costState);
        try {
            const screen = await renderRowActionRevealSlotRows();

            expect(screen.findAllByTestId(`pin:${ROW_ACTION_REVEAL_SLOT_COST_ROW_COUNT - 1}`)).toHaveLength(1);
            expect(costState.animatedValues).toBe(0);
            expect(costState.timings).toBe(0);
            expect(costState.changeListeners).toHaveLength(0);
        } finally {
            restoreWindow();
        }
    });
});
