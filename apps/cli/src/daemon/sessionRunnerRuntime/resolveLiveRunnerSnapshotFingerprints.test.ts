import { describe, it, expect } from 'vitest';

import { decidePinnedRunnerSnapshotPrune } from '@/utils/pinnedRunnerSnapshotPrune';

import { resolveLiveRunnerSnapshotFingerprints } from './resolveLiveRunnerSnapshotFingerprints';

const SNAPSHOT_ROOT = '/Users/alice/dev/happier/apps/cli/.runner-snapshots';

describe('resolveLiveRunnerSnapshotFingerprints', () => {
  it('collects snapshot fingerprints from live runner process commands', () => {
    const live = resolveLiveRunnerSnapshotFingerprints([
      {
        processCommand: `node --no-warnings --no-deprecation ${SNAPSHOT_ROOT}/2ee2ef1b2f776a89/index.mjs claude --happy-starting-mode remote`,
      },
      {
        processCommand: `node ${SNAPSHOT_ROOT}/6d3b1f462ef4a643/index.mjs claude --started-by daemon`,
      },
    ]);

    expect(live.reliable).toBe(true);
    expect([...live.fingerprints].sort()).toEqual(['2ee2ef1b2f776a89', '6d3b1f462ef4a643']);
  });

  it('prefers the untruncated spawn argv over a truncated process command', () => {
    const live = resolveLiveRunnerSnapshotFingerprints([
      {
        // ps-truncated command loses the entrypoint entirely.
        processCommand: 'node --no-warnings --no-deprecation /Users/alice/dev/happier/apps/cli/.runner-sna',
        childProcess: {
          spawnargs: [
            'node',
            '--no-warnings',
            '--no-deprecation',
            `${SNAPSHOT_ROOT}/0c53de7737667471/index.mjs`,
            'claude',
            '--happy-starting-mode',
            'remote',
          ],
        },
      },
    ]);

    expect(live.reliable).toBe(true);
    expect([...live.fingerprints]).toEqual(['0c53de7737667471']);
  });

  it('stays reliable for runners positively identified as non-snapshot', () => {
    const live = resolveLiveRunnerSnapshotFingerprints([
      { processCommand: 'node /opt/happier/versions/1.2.3/dist/index.mjs claude' },
      { processCommand: 'node /Users/alice/dev/happier/apps/cli/dist/index.mjs claude' },
    ]);

    expect(live.reliable).toBe(true);
    expect(live.fingerprints.size).toBe(0);
  });

  it('marks the live set UNRELIABLE when any runner has no command at all', () => {
    // Daemon-restart-adopted runner whose command was never captured: its snapshot reference (if
    // any) cannot be determined, so no deletion decision is safe.
    const live = resolveLiveRunnerSnapshotFingerprints([
      { processCommand: `node ${SNAPSHOT_ROOT}/2ee2ef1b2f776a89/index.mjs claude` },
      {},
    ]);

    expect(live.reliable).toBe(false);
  });

  it('marks the live set UNRELIABLE when a runner identity cannot be parsed (truncated command, no spawnargs)', () => {
    const live = resolveLiveRunnerSnapshotFingerprints([
      {
        // Adopted after daemon restart: no spawnargs, and ps truncated the command before the
        // entrypoint — the runner MAY be snapshot-backed but we cannot prove which one.
        processCommand: 'node --no-warnings --no-deprecation /Users/alice/dev/happier/apps/cli/.runner-sna',
      },
    ]);

    expect(live.reliable).toBe(false);
  });

  it('an unparseable tracked runner makes the composed prune decision delete nothing', () => {
    const live = resolveLiveRunnerSnapshotFingerprints([
      { processCommand: 'node --no-warnings --no-deprecation /Users/alice/dev/happier/apps/cli/.runner-sna' },
    ]);

    const decision = decidePinnedRunnerSnapshotPrune({
      entries: [
        { name: '0c53de7737667471', mtimeMs: 1_000 },
        { name: 'dead0000000000a1', mtimeMs: 2_000 },
        { name: 'dead0000000000a2', mtimeMs: 3_000 },
      ],
      keepFingerprint: 'currentbuild0001',
      live,
      keepCount: 0,
    });

    expect(decision.deletable).toEqual([]);
    expect(decision.skipped).toBe('live_data_unreliable');
  });
});
