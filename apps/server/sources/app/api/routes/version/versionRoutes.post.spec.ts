import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientVersionCheckResponseV1Schema } from '@happier-dev/protocol';
import { createRouteTestBuilder } from '../../testkit/routeTestBuilder';

describe('versionRoutes POST /v1/version', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    async function invokeRaw(body: Record<string, unknown>) {
        const { versionRoutes } = await import('./versionRoutes');
        const route = createRouteTestBuilder({
            method: 'POST',
            path: '/v1/version',
            registerRoutes(app) {
                versionRoutes(app as never);
            },
        });
        const { response } = await route.invoke({ body });
        return response;
    }

    async function invoke(body: Record<string, unknown>) {
        return ClientVersionCheckResponseV1Schema.parse(await invokeRaw(body));
    }

    it('returns the protocol-owned current response for a supported native app', async () => {
        await expect(invoke({
            v: 1,
            clientKind: 'ui-ios',
            appVersion: '1.4.1',
            releaseChannel: 'stable',
            appId: 'dev.happier.app',
        })).resolves.toEqual({ v: 1, status: 'current' });
    });

    it('returns a non-dismissible protocol-owned required upgrade for an old iOS app', async () => {
        await expect(invoke({
            v: 1,
            clientKind: 'ui-ios',
            appVersion: '1.3.0',
            appId: 'dev.happier.app',
        })).resolves.toEqual({
            v: 1,
            status: 'upgrade-required',
            minimumAppVersion: '1.4.1',
            updateUrl: 'https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758537388',
        });
    });

    it('keeps required upgrade truthful when no safe Android update URL is configured', async () => {
        await expect(invoke({
            v: 1,
            clientKind: 'ui-android',
            appVersion: '1.0.0',
            appId: 'dev.happier.app',
        })).resolves.toEqual({
            v: 1,
            status: 'upgrade-required',
            minimumAppVersion: '1.4.1',
            updateUrl: null,
        });
    });

    it('keeps the deployed native request/response shape working during the compatibility rollout', async () => {
        await expect(invokeRaw({
            platform: 'ios',
            version: '1.3.0',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            update_required: true,
            update_url: 'https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758537388',
        });
    });

    it('uses the central compatibility minimum when it is stricter than the distribution floor', async () => {
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'required');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION', '2');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON', JSON.stringify({
            'ui-ios': '1.5.0',
        }));

        await expect(invoke({
            v: 1,
            clientKind: 'ui-ios',
            appVersion: '1.4.1',
            appId: 'dev.happier.app',
        })).resolves.toEqual({
            v: 1,
            status: 'upgrade-required',
            minimumAppVersion: '1.5.0',
            updateUrl: 'https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758537388',
        });
    });
});
