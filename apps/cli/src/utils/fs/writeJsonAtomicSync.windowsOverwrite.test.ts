import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync as renameSyncMock,
  unlinkSync as unlinkSyncMock,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

import { writeJsonAtomicSync } from './writeJsonAtomicSync';

describe('writeJsonAtomicSync (replacement failure)', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(renameSyncMock).mockReset().mockImplementation(actual.renameSync);
    vi.mocked(unlinkSyncMock).mockClear();
  });

  it('retries the same rename after one transient conflict without unlinking the destination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-writeJsonAtomicSync-win-'));
    const path = join(dir, 'daemon.json');
    const oldBytes = '{"state":"complete"}\n';
    const conflict = new Error('EEXIST') as NodeJS.ErrnoException;
    conflict.code = 'EEXIST';
    vi.mocked(renameSyncMock).mockImplementationOnce(() => {
      throw conflict;
    });
    writeFileSync(path, oldBytes, 'utf8');

    expect(() => writeJsonAtomicSync(path, { state: 'replacement' })).not.toThrow();

    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ state: 'replacement' }, null, 2));
    expect(renameSyncMock).toHaveBeenCalledTimes(2);
    expect(unlinkSyncMock).not.toHaveBeenCalledWith(path);
    expect(readdirSync(dir)).toEqual(['daemon.json']);
  });

  it.each(['EPERM', 'EEXIST'] as const)(
    'bounds persistent %s retries, preserves exact old bytes, and removes only the temp file',
    (code) => {
      const dir = mkdtempSync(join(tmpdir(), 'happier-writeJsonAtomicSync-win-persistent-'));
      const path = join(dir, 'daemon.json');
      const oldBytes = '{"state":"complete"}\n';
      const conflict = new Error(code) as NodeJS.ErrnoException;
      conflict.code = code;
      vi.mocked(renameSyncMock).mockImplementation(() => {
        throw conflict;
      });
      writeFileSync(path, oldBytes, 'utf8');

      expect(() => writeJsonAtomicSync(path, { state: 'replacement' })).toThrow(conflict);

      expect(readFileSync(path, 'utf8')).toBe(oldBytes);
      expect(renameSyncMock).toHaveBeenCalledTimes(3);
      expect(unlinkSyncMock).not.toHaveBeenCalledWith(path);
      expect(readdirSync(dir)).toEqual(['daemon.json']);
    },
  );

  it('does not retry a non-conflict rename error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-writeJsonAtomicSync-other-error-'));
    const path = join(dir, 'daemon.json');
    const error = new Error('EACCES') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    vi.mocked(renameSyncMock).mockImplementation(() => {
      throw error;
    });
    writeFileSync(path, '{"state":"complete"}\n', 'utf8');

    expect(() => writeJsonAtomicSync(path, { state: 'replacement' })).toThrow(error);

    expect(renameSyncMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncMock).not.toHaveBeenCalledWith(path);
    expect(readdirSync(dir)).toEqual(['daemon.json']);
  });
});
