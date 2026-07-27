import { mkdtemp, readFile, rename as renameMock, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const renameControl = vi.hoisted(() => ({
  callCount: 0,
  blockFirst: false,
  firstBlocked: null as null | (() => void),
  releaseFirst: null as null | (() => void),
  secondStarted: null as null | (() => void),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const actualRename = actual.rename;

  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      renameControl.callCount += 1;
      if (renameControl.blockFirst && renameControl.callCount === 1) {
        renameControl.firstBlocked?.();
        await new Promise<void>((resolve) => {
          renameControl.releaseFirst = resolve;
        });
      }
      if (renameControl.blockFirst && renameControl.callCount === 2) {
        renameControl.secondStarted?.();
      }
      await actualRename(from, to);
    }),
  };
});

import { createRecoveryIntentFileStore } from './recoveryIntentFileStore';

describe('createRecoveryIntentFileStore', () => {
  beforeEach(() => {
    renameControl.callCount = 0;
    renameControl.blockFirst = false;
    renameControl.firstBlocked = null;
    renameControl.releaseFirst = null;
    renameControl.secondStarted = null;
    vi.clearAllMocks();
  });

  it('does not steal a stale-looking transaction lock from a live owning process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-live-lock-'));
    const filePath = join(dir, 'runtime-auth.json');
    const lockPath = `${filePath}.lock`;
    try {
      const liveOwner = JSON.stringify({
        pid: process.pid,
        ownerToken: 'owner-token',
        processStartedAtMs: Math.trunc(Date.now() - (process.uptime() * 1_000)),
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      await writeFile(lockPath, liveOwner, 'utf8');
      await utimes(lockPath, new Date(1_000), new Date(1_000));

      const write = createRecoveryIntentFileStore(filePath, {
        lockAcquireTimeoutMs: 250,
        staleLockAfterMs: 1,
      }).write('session-a', { status: 'waiting' });
      await expect(write).rejects.toThrow('recovery_intent_file_store_lock_timeout');
      await expect(readFile(lockPath, 'utf8')).resolves.toBe(liveOwner);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes so older snapshots cannot overwrite newer intents', async () => {
    renameControl.blockFirst = true;
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    const filePath = join(dir, 'runtime-auth.json');
    const store = createRecoveryIntentFileStore(filePath);

    const firstBlocked = new Promise<void>((resolve) => {
      renameControl.firstBlocked = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      renameControl.secondStarted = resolve;
    });

    const first = store.write('session-a', { status: 'waiting', attempt: 1 });
    await firstBlocked;

    const second = store.write('session-b', { status: 'waiting', attempt: 2 });
    await Promise.race([
      secondStarted,
      new Promise((resolve) => setTimeout(resolve, 25)),
    ]);
    renameControl.releaseFirst?.();

    await Promise.all([first, second]);

    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      intentsBySessionId: {
        'session-a': { status: 'waiting', attempt: 1 },
        'session-b': { status: 'waiting', attempt: 2 },
      },
    });
    expect(vi.mocked(renameMock).mock.calls.filter((call) => call[1] === filePath)).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });

  it('removes cleared recovery intents from the persisted snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    const filePath = join(dir, 'runtime-auth.json');
    const store = createRecoveryIntentFileStore(filePath);

    await store.write('session-a', { status: 'waiting', attempt: 1 });
    await store.write('session-b', { status: 'waiting', attempt: 2 });
    await store.remove?.('session-a');

    expect(store.read('session-a')).toBeNull();
    expect(store.read('session-b')).toEqual({ status: 'waiting', attempt: 2 });

    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      intentsBySessionId: {
        'session-b': { status: 'waiting', attempt: 2 },
      },
    });

    await rm(dir, { recursive: true, force: true });
  });

  it('prunes matching recovery intents in one persisted snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    const filePath = join(dir, 'runtime-auth.json');
    const store = createRecoveryIntentFileStore(filePath);

    await store.write('active-session', { status: 'waiting', attempt: 1 });
    await store.write('old-terminal-session', { status: 'cancelled', terminalAtMs: 1_000 });
    await store.write('fresh-terminal-session', { status: 'exhausted', terminalAtMs: 9_500 });

    await expect(store.prune?.(({ value }) => (
      typeof value === 'object'
      && value !== null
      && 'terminalAtMs' in value
      && typeof value.terminalAtMs === 'number'
      && value.terminalAtMs < 5_000
    ))).resolves.toEqual(['old-terminal-session']);

    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      intentsBySessionId: {
        'active-session': { status: 'waiting', attempt: 1 },
        'fresh-terminal-session': { status: 'exhausted', terminalAtMs: 9_500 },
      },
    });

    await rm(dir, { recursive: true, force: true });
  });
});
