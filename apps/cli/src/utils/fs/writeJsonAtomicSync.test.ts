import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeJsonAtomicSync } from './writeJsonAtomicSync';

describe('writeJsonAtomicSync', () => {
  it('atomically overwrites JSON and retains private file permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-writeJsonAtomicSync-'));
    const path = join(dir, 'daemon.json');
    writeFileSync(path, '{"state":"old"}\n', 'utf8');

    writeJsonAtomicSync(path, { state: 'new' });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ state: 'new' });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});
