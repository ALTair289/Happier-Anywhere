import { describe, expect, it } from 'vitest';

import type { AgentCore } from '../types.js';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    buildConnectedServicesBindingsPayload,
    resolveConnectedServiceAccountGroupViableProfileId,
    resolveAgentSupportedConnectedServiceIds,
} from './sessionOptions.js';

const agentCore = {
    id: 'codex',
    connectedServices: {
        supportedServiceIds: ['openai-codex', 'github'],
        supportedKindsByServiceId: {
            'openai-codex': ['oauth'],
        },
    },
} as AgentCore;

describe('connected-service session options', () => {
    it('projects supported profiles without exposing profile secrets', () => {
        const options = buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        {
                            profileId: 'profile_oauth',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: 'dev@example.com',
                        },
                        {
                            profileId: 'profile_token',
                            status: 'connected',
                            kind: 'token',
                            providerEmail: 'token@example.com',
                        },
                        {
                            profileId: ' ',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: 'ignored@example.com',
                        },
                    ],
                },
                {
                    serviceId: 'claude-subscription',
                    profiles: [{ profileId: 'unsupported_service', status: 'connected', kind: 'oauth' }],
                },
            ],
            agentCore,
            supportedConnectedServiceIds: resolveAgentSupportedConnectedServiceIds({
                connectedServicesFeatureEnabled: true,
                agentCore,
            }),
            labelsByKey: {
                'openai-codex/profile_oauth': 'Work OpenAI',
            },
        });

        expect(options).toEqual({
            'openai-codex': [
                {
                    profileId: 'profile_oauth',
                    status: 'connected',
                    kind: 'oauth',
                    providerEmail: 'dev@example.com',
                    label: 'Work OpenAI',
                },
                {
                    profileId: 'profile_token',
                    status: 'unsupported_kind',
                    kind: 'token',
                    providerEmail: 'token@example.com',
                    label: null,
                },
            ],
        });
        expect(JSON.stringify(options)).not.toContain('unsupported_service');
        expect(JSON.stringify(options)).not.toContain('SECRET');
    });

    it('projects account groups and resolves a viable connected member', () => {
        const groups = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: true,
            accountProfileConnectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    groups: [
                        {
                            groupId: 'group_1',
                            displayName: 'Work group',
                            activeProfileId: 'profile_a',
                            memberProfileIds: ['profile_a', 'profile_b'],
                            generation: 7,
                            policy: { autoSwitch: true },
                            state: { status: 'ready' },
                        },
                        {
                            groupId: 'empty',
                            activeProfileId: 'profile_empty',
                            memberProfileIds: [],
                            enabledMemberCount: 0,
                        },
                    ],
                },
            ],
            supportedConnectedServiceIds: ['openai-codex'],
        });

        expect(groups).toEqual({
            'openai-codex': [
                {
                    groupId: 'group_1',
                    label: 'Work group',
                    activeProfileId: 'profile_a',
                    memberProfileIds: ['profile_a', 'profile_b'],
                    generation: 7,
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                },
                {
                    groupId: 'empty',
                    label: 'empty',
                    activeProfileId: 'profile_empty',
                    enabledMemberCount: 0,
                    autoSwitch: false,
                    status: 'needs_members',
                },
            ],
        });
        expect(resolveConnectedServiceAccountGroupViableProfileId({
            group: groups['openai-codex']![0]!,
            connectedProfileIds: ['profile_b'],
        })).toBe('profile_b');
    });

    it('builds bindings payloads from profile and group choices using the same rules as session creation UI', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex', 'github'],
            connectedServiceProfileOptionsByServiceId: {
                'openai-codex': [
                    { profileId: 'profile_a', status: 'connected', kind: 'oauth' },
                    { profileId: 'profile_b', status: 'connected', kind: 'oauth' },
                ],
                github: [{ profileId: 'gh_profile', status: 'needs_reauth', kind: 'oauth' }],
            },
            accountGroupsFeatureEnabled: true,
            accountGroupSwitchingEnabled: true,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [
                    {
                        groupId: 'group_1',
                        label: 'Work group',
                        activeProfileId: 'profile_b',
                        memberProfileIds: ['profile_a', 'profile_b'],
                        enabledMemberCount: 2,
                        autoSwitch: true,
                        status: 'ready',
                    },
                ],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'group_1' },
                github: { source: 'connected', selection: 'profile', profileId: 'gh_profile' },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'group_1' },
                github: { source: 'native' },
            },
        });
    });
});
