import { describe, expect, it } from 'vitest';

import { formatServerRetentionRows } from './formatServerRetentionPolicy';
import { hasFiniteRetentionPolicy, type ServerRetentionPolicy } from './serverRetentionPolicy';

describe('hasFiniteRetentionPolicy', () => {
    it('treats missing domain entries as non-finite instead of throwing', () => {
        expect(() => hasFiniteRetentionPolicy({
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'keep_forever',
            },
        } as any)).not.toThrow();
        expect(hasFiniteRetentionPolicy({
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'keep_forever',
            },
        } as any)).toBe(false);
    });
});

describe('formatServerRetentionRows', () => {
    it('treats omitted optional domain policies as keep-forever rows', () => {
        const policy = {
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'keep_forever',
            },
        } as unknown as ServerRetentionPolicy; // Boundary fixture: older servers may omit domain entries.

        expect(() => formatServerRetentionRows(policy)).not.toThrow();
        expect(formatServerRetentionRows(policy)).toHaveLength(13);
    });
});
