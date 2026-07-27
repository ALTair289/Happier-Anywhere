import type { AccountSettings } from '@happier-dev/protocol';

export type ActiveAccountSettingsSnapshot = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: AccountSettings;
  settingsVersion: number;
  loadedAtMs: number;
  settingsSecretsReadKeys: readonly Uint8Array[];
  scopeKey?: string;
}>;

let active: ActiveAccountSettingsSnapshot | null = null;
const listeners = new Set<(
  previous: ActiveAccountSettingsSnapshot | null,
  next: ActiveAccountSettingsSnapshot,
) => void>();

export type ActiveAccountSettingsSnapshotCommit = Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  didCommit: boolean;
}>;

/**
 * The sole process-local publication cut for account settings.
 *
 * Scoped snapshots are monotonic by server/account version. Equal or older work may reuse the
 * current snapshot but can never replace it or notify consumers. Unscoped snapshots are retained
 * for test and legacy bootstrap callers that cannot establish account identity.
 */
export function commitActiveAccountSettingsSnapshot(
  next: ActiveAccountSettingsSnapshot,
): ActiveAccountSettingsSnapshotCommit {
  const previous = active;
  if (
    previous?.scopeKey
    && next.scopeKey === previous.scopeKey
    && next.settingsVersion <= previous.settingsVersion
  ) {
    return { snapshot: previous, didCommit: false };
  }
  active = next;
  for (const listener of listeners) {
    try {
      listener(previous, next);
    } catch {
      // Applying the canonical local snapshot must not fail because a consumer wake did.
    }
  }
  return { snapshot: next, didCommit: true };
}

export function setActiveAccountSettingsSnapshot(next: ActiveAccountSettingsSnapshot): void {
  commitActiveAccountSettingsSnapshot(next);
}

export function getActiveAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null {
  return active;
}

export function resetActiveAccountSettingsSnapshotForTests(): void {
  active = null;
}

export function subscribeActiveAccountSettingsSnapshot(
  listener: (
    previous: ActiveAccountSettingsSnapshot | null,
    next: ActiveAccountSettingsSnapshot,
  ) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
