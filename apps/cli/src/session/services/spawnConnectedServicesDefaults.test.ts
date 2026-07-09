import { describe, expect, it } from 'vitest';

import { resolveSpawnConnectedServicesDefaults } from './spawnConnectedServicesDefaults';

const codexProfileDefaultSettings = {
  connectedServicesDefaultAuthByAgentIdV1: {
    v: 1,
    bindingsByAgentId: {
      codex: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'test-profile-1' },
        },
      },
    },
  },
};

describe('resolveSpawnConnectedServicesDefaults (R4-2 literal resolver)', () => {
  it('resolves a configured PROFILE default to that exact profile binding', () => {
    // Literal semantics (user-ruled canonical): a stored profile default means that exact account —
    // the resolver never silently upgrades it to an autoSwitch pool at resolution time.
    const result = resolveSpawnConnectedServicesDefaults({
      accountSettings: codexProfileDefaultSettings,
      agentId: 'codex',
    });
    expect(result?.bindingsByServiceId['openai-codex']).toEqual({
      source: 'connected',
      selection: 'profile',
      profileId: 'test-profile-1',
    });
  });

  it('resolves a configured GROUP default to that group binding', () => {
    const result = resolveSpawnConnectedServicesDefaults({
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            codex: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
              },
            },
          },
        },
      },
      agentId: 'codex',
    });
    expect(result?.bindingsByServiceId['openai-codex']).toEqual({
      source: 'connected',
      selection: 'group',
      groupId: 'happier',
    });
  });

  it('returns null when no connected default is configured for the agent', () => {
    const result = resolveSpawnConnectedServicesDefaults({
      accountSettings: {},
      agentId: 'codex',
    });
    expect(result).toBeNull();
  });
});
