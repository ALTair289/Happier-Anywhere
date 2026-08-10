import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import {
    RELEASE_RING_IDS,
    getReleaseRingCatalogEntry,
    type ReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

export const SUPPORTED_UI_DEPLOYMENT_RELEASE_RINGS = RELEASE_RING_IDS;

export type UiBuildProfile = Readonly<
    | { kind: 'legacy' }
    | { kind: 'deployment'; releaseRing: ReleaseRingId }
>;

const UI_BUILD_OVERRIDE_NAMES = new Set([
    'APP_ENV',
    'EAS_PROJECT_ID',
    'EXPO_EAS_PROJECT_ID',
    'EXPO_NO_CLIENT_ENV_VARS',
    'EX_UPDATES_NATIVE_DEBUG',
    'HAPPIER_FEATURE_POLICY_ENV',
    'HAPPIER_SYNC_TUNING_JSON',
    'HAPPY_STACKS_IOS_APP_NAME',
    'HAPPY_STACKS_IOS_BUNDLE_ID',
    'HAPPY_STACKS_MOBILE_SCHEME',
]);

const UI_BUILD_OVERRIDE_PREFIXES = [
    'EXPO_PUBLIC_',
    'EXPO_APP_',
    'EXPO_UPDATES_',
    'EXPO_ANDROID_',
    'EXPO_IOS_',
    'HAPPIER_APP_',
    'HAPPIER_EXPO_',
    'HAPPIER_ANDROID_',
    'HAPPIER_IOS_',
    'HAPPIER_UI_',
    'HAPPIER_BUILD_FEATURES_',
] as const;

function isUiBuildOverrideName(name: string): boolean {
    return UI_BUILD_OVERRIDE_NAMES.has(name)
        || UI_BUILD_OVERRIDE_PREFIXES.some((prefix) => name.startsWith(prefix));
}
function isReleaseRingId(value: unknown): value is ReleaseRingId {
    return typeof value === 'string'
        && (SUPPORTED_UI_DEPLOYMENT_RELEASE_RINGS as readonly string[]).includes(value);
}
function resolveDeploymentProfile(profile: UiBuildProfile): ReleaseRingId | null {
    if (profile.kind === 'legacy') return null;
    if (profile.kind === 'deployment' && isReleaseRingId(profile.releaseRing)) {
        return profile.releaseRing;
    }
    throw new Error(
        `[component-artifacts] unsupported deployment ui release ring; expected one of: ${SUPPORTED_UI_DEPLOYMENT_RELEASE_RINGS.join(', ')}`,
    );
}

export async function resolveUiBuildEnvironment({
    repoRoot,
    env,
    uiBuildProfile,
}: {
    repoRoot: string;
    env: NodeJS.ProcessEnv;
    uiBuildProfile?: UiBuildProfile;
}): Promise<NodeJS.ProcessEnv> {
    const profile = uiBuildProfile ?? { kind: 'legacy' };
    const releaseRingId = resolveDeploymentProfile(profile);
    if (!releaseRingId) {
        return {
            ...env,
            CI: env.CI ?? '1',
            EXPO_UNSTABLE_WEB_MODAL: '1',
        };
    }

    const conflicts = Object.keys(env)
        .filter((name) => env[name] !== undefined && isUiBuildOverrideName(name));
    const appLocalConfigPath = join(repoRoot, 'apps', 'ui', 'app.local.js');
    if (await lstat(appLocalConfigPath).catch(() => null)) {
        conflicts.push('apps/ui/app.local.js');
    }
    if (conflicts.length > 0) {
        throw new Error(
            `[component-artifacts] deployment uiBuildProfile rejected UI build overrides: ${[...new Set(conflicts)].sort().join(', ')}`,
        );
    }

    const releaseRing = getReleaseRingCatalogEntry(releaseRingId);
    const appEnvironment = releaseRingId === 'stable' ? 'production' : releaseRingId;
    return {
        ...env,
        APP_ENV: appEnvironment,
        EXPO_UPDATES_CHANNEL: releaseRing.expoUpdatesChannel,
        EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV: releaseRing.embeddedPolicyEnv,
        EXPO_NO_DOTENV: '1',
        EXPO_UNSTABLE_WEB_MODAL: '1',
        NODE_ENV: 'production',
        BABEL_ENV: 'production',
        CI: '1',
    };
}
