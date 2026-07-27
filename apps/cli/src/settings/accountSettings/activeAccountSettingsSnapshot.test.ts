import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import {
  commitActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';

describe('active account settings snapshot subscriptions', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('notifies subscribers only after the new snapshot is locally visible', () => {
    const first = {
      source: 'network' as const,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      settingsVersion: 10,
      loadedAtMs: 10,
      settingsSecretsReadKeys: [],
    };
    const second = {
      ...first,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
      settingsVersion: 11,
      loadedAtMs: 11,
    };
    setActiveAccountSettingsSnapshot(first);
    const listener = vi.fn(() => getActiveAccountSettingsSnapshot());
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);

    setActiveAccountSettingsSnapshot(second);

    expect(listener).toHaveBeenCalledWith(first, second);
    expect(listener.mock.results[0]?.value).toBe(second);
    unsubscribe();
  });

  it('keeps the accepted same-scope winner for equal and older commits without notifying consumers', () => {
    const winner = {
      source: 'network' as const,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      settingsVersion: 11,
      loadedAtMs: 11,
      settingsSecretsReadKeys: [],
      scopeKey: 'server-a::account-a',
    };
    setActiveAccountSettingsSnapshot(winner);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);

    const equal = commitActiveAccountSettingsSnapshot({
      ...winner,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
    });
    const older = commitActiveAccountSettingsSnapshot({
      ...winner,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
      settingsVersion: 10,
      loadedAtMs: 12,
    });

    expect(equal).toEqual({ snapshot: winner, didCommit: false });
    expect(older).toEqual({ snapshot: winner, didCommit: false });
    expect(getActiveAccountSettingsSnapshot()).toBe(winner);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
