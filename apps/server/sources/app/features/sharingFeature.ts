import type { FeaturesPayloadDelta } from "./types";

export function resolveSharingFeature(
    _env: NodeJS.ProcessEnv = {},
): FeaturesPayloadDelta {
    return {
        features: {
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: true },
                pendingDeliveryState: { enabled: true },
                // PREPARE only. Activation follows once expected provider/mode and cross-row
                // correlation can be compared against a canonical indexed dispatch identity.
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
