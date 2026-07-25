import { CURRENT_PENDING_INPUT_PROTOCOL_VERSION } from '@happier-dev/protocol';

import { resolveSessionSyncCompatibilityPolicy } from '@/app/clientCompatibility/policy';
import type { FeaturesPayloadDelta } from './types';

export function resolveClientCompatibilityFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const policy = resolveSessionSyncCompatibilityPolicy(env);

    return {
        capabilities: {
            compatibility: {
                v: 1,
                sessionSync: policy.requirements,
                pendingInput: {
                    currentPendingInputProtocolVersion: CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
                },
            },
        },
    };
}
