import { describe, expect, it } from 'vitest';

import { resolveSharingFeature } from './sharingFeature';

describe('resolveSharingFeature', () => {
    it('keeps both attempt controls off by default', () => {
        const payload = resolveSharingFeature({});

        expect(payload.features?.sharing?.pendingDeliveryAttempts).toEqual({ enabled: false });
        expect(payload.features?.sharing?.pendingDeliveryAttemptClaims).toEqual({ enabled: false });
    });

    it('resolves attempt controls independently before dependency closure', () => {
        const payload = resolveSharingFeature({
            HAPPIER_FEATURE_SHARING_PENDING_DELIVERY_ATTEMPTS__ENABLED: '0',
            HAPPIER_FEATURE_SHARING_PENDING_DELIVERY_ATTEMPT_CLAIMS__ENABLED: '1',
        });

        expect(payload.features?.sharing?.pendingDeliveryAttempts).toEqual({ enabled: false });
        expect(payload.features?.sharing?.pendingDeliveryAttemptClaims).toEqual({ enabled: true });
    });
});
