import type { FeaturesPayloadDelta } from "./types";
import { readPendingDeliveryAttemptFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveSharingFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const pendingDeliveryAttempt = readPendingDeliveryAttemptFeatureEnv(env);

    return {
        features: {
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: true },
                pendingDeliveryState: { enabled: true },
                pendingDeliveryAttempts: { enabled: pendingDeliveryAttempt.attemptsEnabled },
                pendingDeliveryAttemptClaims: { enabled: pendingDeliveryAttempt.claimsEnabled },
            },
        },
        capabilities: {
            sharing: {
                pendingQueueV2: {
                    deliveryState: true,
                    deliveryBlockedReason: true,
                },
            },
        },
    };
}
