import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env/envSnapshot';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration pending queue', () => {
  const envBackup = snapshotProcessEnv();
  const tempDirs: string[] = [];

  afterEach(() => {
    restoreProcessEnv(envBackup);
    vi.resetModules();
    for (const tempDir of tempDirs) {
      removeTempDirSync(tempDir);
    }
    tempDirs.length = 0;
  });

  it('does not expose a periodic Pending wake poll even when the obsolete env is set', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_PENDING_QUEUE_IDLE_WAKE_POLL_INTERVAL_MS = '60000';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect('pendingQueueIdleWakePollIntervalMs' in configMod.configuration).toBe(false);
  });
});
