import { describe, expect, it } from 'vitest';

import {
    readConnectedServiceProfileKindFromServices,
    resolveConnectedServiceProfileActionRoute,
} from './resolveConnectedServiceProfileActionRoute';

describe('resolveConnectedServiceProfileActionRoute', () => {
    it('routes OAuth profiles to the OAuth reconnect surface', () => {
        expect(resolveConnectedServiceProfileActionRoute({
            serviceId: 'openai-codex',
            profileId: 'work',
            profileKind: 'oauth',
        })).toEqual({
            pathname: '/settings/connected-services/oauth',
            params: { serviceId: 'openai-codex', profileId: 'work' },
        });
    });

    it('routes token and manual profiles to the profile-auth surface', () => {
        for (const profileKind of ['token', 'apiKey', 'api_key', 'manual']) {
            expect(resolveConnectedServiceProfileActionRoute({
                serviceId: 'claude-subscription',
                profileId: 'primary',
                profileKind,
            })).toEqual({
                pathname: '/settings/connected-services/profile',
                params: { serviceId: 'claude-subscription', profileId: 'primary' },
            });
        }
    });

    it('falls back to the connected-services overview for unknown or missing profile data', () => {
        expect(resolveConnectedServiceProfileActionRoute({
            serviceId: 'claude-subscription',
            profileId: 'primary',
            profileKind: 'custom',
        })).toEqual({ pathname: '/settings/connected-services' });

        expect(resolveConnectedServiceProfileActionRoute({
            serviceId: 'claude-subscription',
            profileId: ' ',
            profileKind: 'token',
        })).toEqual({ pathname: '/settings/connected-services' });
    });

    it('reads profile kinds from account profile connected-services data', () => {
        expect(readConnectedServiceProfileKindFromServices({
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'oauth-work', kind: 'oauth' },
                    { profileId: 'api-key-work', kind: 'apiKey' },
                ],
            }],
            serviceId: 'openai-codex',
            profileId: 'api-key-work',
        })).toBe('apiKey');

        expect(readConnectedServiceProfileKindFromServices({
            connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [] }],
            serviceId: 'openai-codex',
            profileId: 'missing',
        })).toBeNull();
    });
});
