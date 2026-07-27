import { describe, expect, it, vi } from 'vitest';

import {
  parseConnectedServicesLaunchAuth,
  resolveCliConnectedServicesLaunchBindings,
  resolveConnectedServicesLaunchAuth,
  resolveConnectedServicesLaunchAuthWithInventory,
} from './connectedServicesLaunchAuth';

const codexInventory = {
  items: [{
    serviceId: 'openai-codex',
    profiles: [{ profileId: 'work', status: 'connected' }],
    accountGroups: [{ groupId: 'team' }],
  }],
};

describe('connectedServicesLaunchAuth', () => {
  it('parses the canonical shorthand without leaking CLI syntax downstream', () => {
    expect(parseConnectedServicesLaunchAuth('default')).toEqual({ kind: 'default' });
    expect(parseConnectedServicesLaunchAuth('native')).toEqual({ kind: 'native' });
    expect(parseConnectedServicesLaunchAuth('cs:team')).toEqual({
      kind: 'connected',
      id: 'team',
      selection: null,
      serviceId: null,
    });
    expect(parseConnectedServicesLaunchAuth('cs:group:team')).toEqual({
      kind: 'connected',
      id: 'team',
      selection: 'group',
      serviceId: null,
    });
    expect(parseConnectedServicesLaunchAuth('cs:openai-codex:profile:work')).toEqual({
      kind: 'connected',
      id: 'work',
      selection: 'profile',
      serviceId: 'openai-codex',
    });
  });

  it('resolves an exact unqualified inventory id to the existing bindings schema', () => {
    expect(resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('cs:team'),
      supportedServiceIds: ['openai-codex'],
      inventory: codexInventory,
    })).toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'team',
        },
      },
    });
  });

  it('represents explicit native selection for every supported service', () => {
    expect(resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('native'),
      supportedServiceIds: ['openai-codex', 'openai'],
      inventory: null,
    })).toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'native' },
        openai: { source: 'native' },
      },
    });
  });

  it('fails closed when an unqualified id is ambiguous', () => {
    expect(() => resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('cs:same'),
      supportedServiceIds: ['openai-codex'],
      inventory: {
        items: [{
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'same', status: 'connected' }],
          accountGroups: [{ groupId: 'same' }],
        }],
      },
    })).toThrow(
      'connected_service_auth_ambiguous:cs:openai-codex:profile:same,cs:openai-codex:group:same',
    );
  });

  it('reports the exact unavailable selector without launching or guessing', () => {
    expect(() => resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('cs:missing'),
      supportedServiceIds: ['openai-codex'],
      inventory: codexInventory,
    })).toThrow('connected_service_auth_not_found:cs:missing');
  });

  it('consults the canonical inventory only for an explicit connected selector', async () => {
    const listInventory = vi.fn(async () => codexInventory);

    await expect(resolveConnectedServicesLaunchAuthWithInventory({
      intent: parseConnectedServicesLaunchAuth('cs:team'),
      supportedServiceIds: ['openai-codex'],
      listInventory,
    })).resolves.toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'team',
        },
      },
    });
    expect(listInventory).toHaveBeenCalledTimes(1);

    listInventory.mockClear();
    await resolveConnectedServicesLaunchAuthWithInventory({
      intent: parseConnectedServicesLaunchAuth('native'),
      supportedServiceIds: ['openai-codex'],
      listInventory,
    });
    expect(listInventory).not.toHaveBeenCalled();
  });

  it('uses the configured Connected Services default when direct CLI auth is omitted', async () => {
    const bindings = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'team' },
      },
    };
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: undefined,
      authJsonRaw: undefined,
      supportedServiceIds: ['openai-codex'],
      defaultDisposition: { kind: 'connected', bindings },
      listInventory: async () => {
        throw new Error('inventory should not be read for defaults');
      },
    })).resolves.toEqual(bindings);
  });

  it('lets explicit native auth override a configured connected default', async () => {
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: 'native',
      authJsonRaw: undefined,
      supportedServiceIds: ['openai-codex'],
      defaultDisposition: {
        kind: 'connected',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
      },
      listInventory: vi.fn(),
    })).resolves.toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'native' },
      },
    });
  });

  it('fails visibly instead of falling back to native when the configured default is invalid', async () => {
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: undefined,
      authJsonRaw: undefined,
      supportedServiceIds: ['openai-codex'],
      defaultDisposition: {
        kind: 'unavailable',
        reason: 'connected_services_default_settings_invalid',
      },
      listInventory: async () => null,
    })).rejects.toThrow('connected_services_default_unavailable');
  });

  it('rejects structured connected-service auth for an unsupported backend', async () => {
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: undefined,
      authJsonRaw: '{"v":1,"bindingsByServiceId":{"openai-codex":{"source":"native"}}}',
      supportedServiceIds: [],
      defaultDisposition: { kind: 'native' },
      listInventory: vi.fn(),
    })).rejects.toThrow('connected_service_auth_unsupported');
  });
});
