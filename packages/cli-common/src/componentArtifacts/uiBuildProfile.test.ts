import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    SUPPORTED_UI_DEPLOYMENT_RELEASE_RINGS,
    resolveUiBuildEnvironment,
    type UiBuildProfile,
} from './uiBuildProfile.js';

const tempDirs: string[] = [];

async function createTempRepo(): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ui-build-profile-'));
    tempDirs.push(repoRoot);
    await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
    return repoRoot;
}

describe('resolveUiBuildEnvironment', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(async (dir) => {
            await rm(dir, { recursive: true, force: true });
        }));
    });

    it('preserves legacy environment behavior when no profile is selected', async () => {
        const repoRoot = await createTempRepo();
        const env = {
            CI: '0',
            EXPO_PUBLIC_CUSTOM_OVERRIDE: 'legacy-value',
            HAPPIER_UI_KEEP_CONSOLE_IN_RELEASE: '1',
        };

        const resolved = await resolveUiBuildEnvironment({ repoRoot, env });

        expect(resolved).not.toBe(env);
        expect(resolved).toMatchObject({
            CI: '0',
            EXPO_UNSTABLE_WEB_MODAL: '1',
            EXPO_PUBLIC_CUSTOM_OVERRIDE: 'legacy-value',
            HAPPIER_UI_KEEP_CONSOLE_IN_RELEASE: '1',
        });
    });

    it.each([
        ['stable', 'production', 'production', 'production'],
        ['preview', 'preview', 'preview', 'preview'],
        ['publicdev', 'publicdev', 'dev', 'preview'],
        ['internalpreview', 'internalpreview', 'internalpreview', 'preview'],
        ['internaldev', 'internaldev', 'internaldev', ''],
    ] as const)(
        'pins the %s deployment profile to its canonical app environment, updates channel, and feature policy',
        async (releaseRing, appEnv, updatesChannel, featurePolicyEnv) => {
            const repoRoot = await createTempRepo();
            const resolved = await resolveUiBuildEnvironment({
                repoRoot,
                env: { HAPPIER_INSTALL_SCOPE: 'ui,protocol' },
                uiBuildProfile: { kind: 'deployment', releaseRing },
            });

            expect(resolved).toMatchObject({
                APP_ENV: appEnv,
                EXPO_UPDATES_CHANNEL: updatesChannel,
                EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV: featurePolicyEnv,
                EXPO_NO_DOTENV: '1',
                EXPO_UNSTABLE_WEB_MODAL: '1',
                NODE_ENV: 'production',
                BABEL_ENV: 'production',
                CI: '1',
                HAPPIER_INSTALL_SCOPE: 'ui,protocol',
            });
        },
    );

    it('enumerates only canonical release rings and rejects an unsupported deployment profile', async () => {
        const repoRoot = await createTempRepo();
        expect(SUPPORTED_UI_DEPLOYMENT_RELEASE_RINGS).toEqual([
            'stable',
            'preview',
            'publicdev',
            'internalpreview',
            'internaldev',
        ]);

        await expect(resolveUiBuildEnvironment({
            repoRoot,
            env: {},
            uiBuildProfile: { kind: 'deployment', releaseRing: 'nightly' } as unknown as UiBuildProfile,
        })).rejects.toThrow(/unsupported deployment ui release ring.*stable.*preview.*publicdev.*internalpreview.*internaldev/i);
    });

    it('rejects ambient UI overrides by variable name without disclosing their values', async () => {
        const repoRoot = await createTempRepo();
        const secretValue = 'do-not-print-this-secret';

        let message = '';
        try {
            await resolveUiBuildEnvironment({
                repoRoot,
                env: {
                    APP_ENV: 'preview',
                    EXPO_APP_LOCAL_CONFIG_PATH: `C:/private/${secretValue}.js`,
                    EXPO_PUBLIC_HAPPY_SERVER_URL: `https://${secretValue}.invalid`,
                    HAPPIER_APP_VARIANT_OVERRIDE: secretValue,
                    HAPPIER_UI_KEEP_CONSOLE_IN_RELEASE: secretValue,
                },
                uiBuildProfile: { kind: 'deployment', releaseRing: 'stable' },
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain('APP_ENV');
        expect(message).toContain('EXPO_APP_LOCAL_CONFIG_PATH');
        expect(message).toContain('EXPO_PUBLIC_HAPPY_SERVER_URL');
        expect(message).toContain('HAPPIER_APP_VARIANT_OVERRIDE');
        expect(message).toContain('HAPPIER_UI_KEEP_CONSOLE_IN_RELEASE');
        expect(message).not.toContain(secretValue);
        expect(message).not.toContain('https://');
    });

    it('rejects apps/ui/app.local.js before it can inject environment or Expo config', async () => {
        const repoRoot = await createTempRepo();
        const secretValue = 'local-config-secret-value';
        await writeFile(join(repoRoot, 'apps', 'ui', 'app.local.js'), `module.exports = { env: { TOKEN: '${secretValue}' } };\n`, 'utf8');

        let message = '';
        try {
            await resolveUiBuildEnvironment({
                repoRoot,
                env: {},
                uiBuildProfile: { kind: 'deployment', releaseRing: 'stable' },
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain('apps/ui/app.local.js');
        expect(message).not.toContain(secretValue);
    });
});
