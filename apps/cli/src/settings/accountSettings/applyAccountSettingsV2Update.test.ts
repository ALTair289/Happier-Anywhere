import { accountSettingsParse } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';

import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';
import { applyAccountSettingsV2Update } from './bootstrapAccountSettingsContext';
import { resolveAccountSettingsScopeKey } from './accountSettingsScopeKey';

function credentials(token: string): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
  };
}

function snapshot(params: Readonly<{
  credentials: Credentials;
  version: number;
  timing: 'after_foreground_ready' | 'after_runtime_idle';
}>) {
  return {
    source: 'network' as const,
    settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: params.timing }),
    settingsVersion: params.version,
    loadedAtMs: params.version,
    settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKey(params.credentials),
  };
}

describe('applyAccountSettingsV2Update', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('does not replace a newer or equal-version snapshot from the same account', async () => {
    const accountCredentials = credentials('account-a');
    const current = snapshot({
      credentials: accountCredentials,
      version: 3,
      timing: 'after_runtime_idle',
    });
    setActiveAccountSettingsSnapshot(current);

    const older = await applyAccountSettingsV2Update({
      credentials: accountCredentials,
      update: {
        content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
        version: 2,
      },
    });
    const equalButDifferent = await applyAccountSettingsV2Update({
      credentials: accountCredentials,
      update: {
        content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
        version: 3,
      },
    });

    expect(older.settingsVersion).toBe(3);
    expect(equalButDifferent.settingsVersion).toBe(3);
    expect(getActiveAccountSettingsSnapshot()).toBe(current);
    expect(getActiveAccountSettingsSnapshot()?.settings.sessionPendingQueueDeliveryTiming)
      .toBe('after_runtime_idle');
  });

  it('rejects a delayed update when the active account scope changes during decryption', async () => {
    const accountA = credentials('account-a');
    const accountB = credentials('account-b');
    setActiveAccountSettingsSnapshot(snapshot({
      credentials: accountA,
      version: 1,
      timing: 'after_foreground_ready',
    }));
    let finishDecrypt: (value: Record<string, unknown>) => void = () => {};
    const decryptCiphertext = () => new Promise<Record<string, unknown>>((resolve) => {
      finishDecrypt = resolve;
    });

    const applying = applyAccountSettingsV2Update({
      credentials: accountA,
      update: { content: { t: 'encrypted', c: 'ciphertext' }, version: 2 },
      deps: { decryptCiphertext },
    });
    const accountBSnapshot = snapshot({
      credentials: accountB,
      version: 4,
      timing: 'after_runtime_idle',
    });
    setActiveAccountSettingsSnapshot(accountBSnapshot);
    finishDecrypt({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' });

    await expect(applying).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_SCOPE_CHANGED' });
    expect(getActiveAccountSettingsSnapshot()).toBe(accountBSnapshot);
  });

  it('rejects an update whose live source closes while decryption is in flight', async () => {
    const accountCredentials = credentials('account-a');
    const current = snapshot({
      credentials: accountCredentials,
      version: 1,
      timing: 'after_foreground_ready',
    });
    setActiveAccountSettingsSnapshot(current);
    let finishDecrypt: (value: Record<string, unknown>) => void = () => {};
    const decryptCiphertext = () => new Promise<Record<string, unknown>>((resolve) => {
      finishDecrypt = resolve;
    });
    let sourceCurrent = true;

    const applying = applyAccountSettingsV2Update({
      credentials: accountCredentials,
      update: { content: { t: 'encrypted', c: 'ciphertext' }, version: 2 },
      shouldCommit: () => sourceCurrent,
      deps: { decryptCiphertext },
    });
    sourceCurrent = false;
    finishDecrypt({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' });

    await expect(applying).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_SOURCE_STALE' });
    expect(getActiveAccountSettingsSnapshot()).toBe(current);
  });
});
