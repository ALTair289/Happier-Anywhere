import { resolveSessionSyncCompatibilityPolicy } from '@/app/clientCompatibility/policy';
import { readSessionRuntimeActivityV2FeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveClientCompatibilityFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const policy = resolveSessionSyncCompatibilityPolicy(env);
    const feature = readSessionRuntimeActivityV2FeatureEnv(env);

    return {
        features: {
            sessions: {
                enabled: true,
                runtimeActivityV2: {
                    enabled: feature.runtimeActivityV2Enabled && policy.runtimeActivityV2Eligible,
                },
            },
        },
        capabilities: {
            compatibility: {
                v: 1,
                sessionSync: policy.requirements,
            },
        },
    };
}
