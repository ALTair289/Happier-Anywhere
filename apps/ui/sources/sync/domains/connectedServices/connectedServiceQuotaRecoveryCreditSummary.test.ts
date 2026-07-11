import { describe, expect, it } from 'vitest';

import { ConnectedServiceQuotaRecoveryCreditsV1Schema } from '@happier-dev/protocol';

import { summarizeConnectedServiceQuotaRecoveryCredits } from './connectedServiceQuotaRecoveryCreditSummary';

describe('summarizeConnectedServiceQuotaRecoveryCredits', () => {
    it('keeps availableCount authoritative when detail rows are capped', () => {
        const credits = ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
            kind: 'usage_limit_resets',
            availableCount: 3,
            credits: [{ kind: 'usage_limit_reset', status: 'available', providerCreditId: 'detail-1' }],
        });

        expect(summarizeConnectedServiceQuotaRecoveryCredits(credits, 1_000)).toEqual({
            availableCount: 3,
            nextExpiresAtMs: null,
            providerCreditId: 'detail-1',
        });
    });
});
