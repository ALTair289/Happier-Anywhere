import { afterEach, describe, expect, it } from 'vitest';

import {
    resolveTurnDiffFileBudgetBytes,
    resolveTurnDiffTurnBudgetBytes,
} from './turnDiffPayloadBudget';

const FILE_BUDGET_ENV = 'HAPPIER_TURN_DIFF_FILE_BUDGET_BYTES';
const TURN_BUDGET_ENV = 'HAPPIER_TURN_DIFF_TURN_BUDGET_BYTES';

describe('turnDiffPayloadBudget', () => {
    afterEach(() => {
        delete process.env[FILE_BUDGET_ENV];
        delete process.env[TURN_BUDGET_ENV];
    });

    it('defaults the per-file budget to 256KB and the per-turn budget to 1MB', () => {
        expect(resolveTurnDiffFileBudgetBytes(undefined)).toBe(256 * 1024);
        expect(resolveTurnDiffTurnBudgetBytes(undefined)).toBe(1024 * 1024);
    });

    it('accepts explicit numeric and string inputs', () => {
        expect(resolveTurnDiffFileBudgetBytes(1234)).toBe(1234);
        expect(resolveTurnDiffFileBudgetBytes('2048')).toBe(2048);
        expect(resolveTurnDiffTurnBudgetBytes(0)).toBe(0);
    });

    it('reads env overrides when no explicit input is provided', () => {
        process.env[FILE_BUDGET_ENV] = '4096';
        process.env[TURN_BUDGET_ENV] = '8192';
        expect(resolveTurnDiffFileBudgetBytes(undefined)).toBe(4096);
        expect(resolveTurnDiffTurnBudgetBytes(undefined)).toBe(8192);
    });

    it('falls back to defaults on invalid input', () => {
        expect(resolveTurnDiffFileBudgetBytes('not-a-number')).toBe(256 * 1024);
        expect(resolveTurnDiffFileBudgetBytes(-5)).toBe(256 * 1024);
        expect(resolveTurnDiffTurnBudgetBytes('')).toBe(1024 * 1024);
    });
});
