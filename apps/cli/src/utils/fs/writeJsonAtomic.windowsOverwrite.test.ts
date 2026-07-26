import { mkdtemp, readFile, readdir, writeFile, rename as renameMock, unlink as unlinkMock } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  return {
    ...actual,
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

import { writeJsonAtomic } from './writeJsonAtomic';

describe('writeJsonAtomic (windows overwrite)', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(renameMock).mockReset().mockImplementation(actual.rename);
    vi.mocked(unlinkMock).mockClear();
  });

  it('retries the same rename after one transient conflict without unlinking the destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-'));
    const path = join(dir, 'auth.json');
    const oldBytes = '{"a":1}\n';
    const conflict = new Error('EPERM') as NodeJS.ErrnoException;
    conflict.code = 'EPERM';
    vi.mocked(renameMock).mockRejectedValueOnce(conflict);

    await writeFile(path, oldBytes, 'utf8');
    await expect(writeJsonAtomic(path, { a: 2, b: 'x' })).resolves.toBeUndefined();

    await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify({ a: 2, b: 'x' }, null, 2));
    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
    await expect(readdir(dir)).resolves.toEqual(['auth.json']);
  });

  it.each(['EPERM', 'EEXIST'] as const)(
    'bounds persistent %s retries, preserves exact old bytes, and removes only the temp file',
    async (code) => {
      const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-persistent-'));
      const path = join(dir, 'auth.json');
      const oldBytes = '{"a":1}\n';
      const conflict = new Error(code) as NodeJS.ErrnoException;
      conflict.code = code;
      vi.mocked(renameMock).mockRejectedValue(conflict);

      await writeFile(path, oldBytes, 'utf8');
      await expect(writeJsonAtomic(path, { a: 2 })).rejects.toBe(conflict);

      await expect(readFile(path, 'utf8')).resolves.toBe(oldBytes);
      expect(renameMock).toHaveBeenCalledTimes(3);
      expect(unlinkMock).not.toHaveBeenCalledWith(path);
      await expect(readdir(dir)).resolves.toEqual(['auth.json']);
    },
  );

  it('does not retry a non-conflict rename error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-other-error-'));
    const path = join(dir, 'auth.json');
    const error = new Error('EACCES') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    vi.mocked(renameMock).mockRejectedValue(error);

    await writeFile(path, '{"a":1}\n', 'utf8');
    await expect(writeJsonAtomic(path, { a: 2 })).rejects.toBe(error);

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
    await expect(readdir(dir)).resolves.toEqual(['auth.json']);
  });
});
