import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  describeMissingRunnerSnapshotRoot,
  __resetRunnerSnapshotRootWarningForTests,
  warnIfOwnRunnerSnapshotRootMissing,
} from './warnMissingRunnerSnapshotRoot';

const SNAPSHOT_ENTRYPOINT =
  '/Users/alice/dev/happier/apps/cli/.runner-snapshots/0c53de7737667471/index.mjs';

describe('describeMissingRunnerSnapshotRoot', () => {
  it('flags an entrypoint whose snapshot root no longer exists', () => {
    const result = describeMissingRunnerSnapshotRoot({
      entrypointPath: SNAPSHOT_ENTRYPOINT,
      rootExists: () => false,
    });
    expect(result).not.toBeNull();
    expect(result?.fingerprint).toBe('0c53de7737667471');
    expect(result?.snapshotRoot).toContain('.runner-snapshots/0c53de7737667471');
  });

  it('returns null when the snapshot root still exists', () => {
    const result = describeMissingRunnerSnapshotRoot({
      entrypointPath: SNAPSHOT_ENTRYPOINT,
      rootExists: () => true,
    });
    expect(result).toBeNull();
  });

  it('returns null for a non-snapshot entrypoint', () => {
    const result = describeMissingRunnerSnapshotRoot({
      entrypointPath: '/opt/happier/versions/1.2.3/dist/index.mjs',
      rootExists: () => false,
    });
    expect(result).toBeNull();
  });
});

describe('warnIfOwnRunnerSnapshotRootMissing', () => {
  beforeEach(() => {
    __resetRunnerSnapshotRootWarningForTests();
  });

  it('warns once naming the snapshot and runner pid', () => {
    const warn = vi.fn();
    const warned1 = warnIfOwnRunnerSnapshotRootMissing({
      entrypointPath: SNAPSHOT_ENTRYPOINT,
      pid: 12081,
      rootExists: () => false,
      warn,
    });
    const warned2 = warnIfOwnRunnerSnapshotRootMissing({
      entrypointPath: SNAPSHOT_ENTRYPOINT,
      pid: 12081,
      rootExists: () => false,
      warn,
    });

    expect(warned1).toBe(true);
    expect(warned2).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('0c53de7737667471');
    expect(warn.mock.calls[0][0]).toContain('12081');
  });

  it('does not warn when the snapshot root is present', () => {
    const warn = vi.fn();
    const warned = warnIfOwnRunnerSnapshotRootMissing({
      entrypointPath: SNAPSHOT_ENTRYPOINT,
      pid: 12081,
      rootExists: () => true,
      warn,
    });
    expect(warned).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
