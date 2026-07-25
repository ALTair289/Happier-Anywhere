import { describe, expect, it } from 'vitest';

import { UpdateBodySchema } from './updates.js';

describe('account settings update bodies', () => {
  it('parses the canonical v2 account settings payload carried by user-scoped updates', () => {
    const parsed = UpdateBodySchema.parse({
      t: 'update-account',
      id: 'account-1',
      settingsV2: {
        content: { t: 'encrypted', c: 'ciphertext' },
        version: 12,
      },
    });

    expect(parsed).toEqual({
      t: 'update-account',
      id: 'account-1',
      settingsV2: {
        content: { t: 'encrypted', c: 'ciphertext' },
        version: 12,
      },
    });
  });

  it('rejects malformed v2 account settings payloads instead of treating them as opaque extras', () => {
    expect(UpdateBodySchema.safeParse({
      t: 'update-account',
      id: 'account-1',
      settingsV2: {
        content: { t: 'encrypted', c: '' },
        version: 12,
      },
    }).success).toBe(false);
  });

  it('uses the strict canonical account settings response schema for nested live payloads', () => {
    expect(UpdateBodySchema.safeParse({
      t: 'update-account',
      id: 'account-1',
      settingsV2: {
        content: { t: 'plain', v: {} },
        version: 12,
        unexpected: true,
      },
    }).success).toBe(false);
  });

  it('accepts compact account settings changed hints without settings content', () => {
    const parsed = UpdateBodySchema.parse({
      t: 'account-settings-changed',
      settingsVersion: 12,
    });

    expect(parsed).toEqual({
      t: 'account-settings-changed',
      settingsVersion: 12,
    });
  });
});
