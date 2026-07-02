import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createOpenCodeManagedServerLogCapture,
  formatOpenCodeManagedServerLogTimestamp,
  pruneOpenCodeManagedServerLogs,
  resolveOpenCodeManagedServerLogPath,
  resolveOpenCodeManagedServersLogDir,
} from './index';

const TEMP_DIRS = new Set<string>();

async function makeLogsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-mslogs-'));
  TEMP_DIRS.add(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of TEMP_DIRS) await rm(dir, { recursive: true, force: true }).catch(() => {});
  TEMP_DIRS.clear();
});

describe('resolveOpenCodeManagedServerLogPath', () => {
  it('builds a deterministic path under opencode-managed-servers with port and pid', () => {
    const now = new Date('2026-06-22T17:24:54.000Z');
    const path = resolveOpenCodeManagedServerLogPath({ logsDir: '/logs', port: 50842, pid: 12143, now });
    expect(path.startsWith(resolveOpenCodeManagedServersLogDir('/logs'))).toBe(true);
    expect(path).toContain('-port-50842-pid-12143.log');
    const ts = formatOpenCodeManagedServerLogTimestamp(now);
    expect(path).toContain(ts);
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  });

  it('uses pending pid and unknown port labels when not yet known', () => {
    const path = resolveOpenCodeManagedServerLogPath({ logsDir: '/logs', port: 0, pid: null });
    expect(path).toContain('-port-unknown-pid-pending.log');
  });
});

describe('pruneOpenCodeManagedServerLogs', () => {
  it('keeps the newest N logs by count and never deletes the just-created log', async () => {
    const logsDir = await makeLogsDir();
    const dir = resolveOpenCodeManagedServersLogDir(logsDir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });

    const names = [
      '2026-06-22-10-00-00-port-1-pid-1.log',
      '2026-06-22-11-00-00-port-1-pid-2.log',
      '2026-06-22-12-00-00-port-1-pid-3.log',
      '2026-06-22-13-00-00-port-1-pid-4.log',
    ];
    for (const name of names) await writeFile(join(dir, name), 'x', 'utf8');

    // Keep newest 2, but also keep the OLDEST (current) one explicitly.
    const keepPath = join(dir, names[0]);
    await pruneOpenCodeManagedServerLogs({ logsDir, keepCount: 2, keepPath });

    const remaining = (await readdir(dir)).filter((n) => n.endsWith('.log')).sort();
    expect(remaining).toEqual([
      '2026-06-22-10-00-00-port-1-pid-1.log', // current (kept despite being oldest)
      '2026-06-22-12-00-00-port-1-pid-3.log',
      '2026-06-22-13-00-00-port-1-pid-4.log',
    ]);
  });
});

describe('createOpenCodeManagedServerLogCapture', () => {
  it('writes a header without secrets and persists post-start stdout/stderr lines', async () => {
    const logsDir = await makeLogsDir();
    const capture = createOpenCodeManagedServerLogCapture({
      logsDir,
      port: 50842,
      spawnPid: 12143,
      commandBasename: 'opencode',
      args: ['serve', '--hostname=127.0.0.1', '--port=50842'],
      hostname: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:50842',
      launchFingerprint: 'fp-abc',
    });

    expect(capture.logPath.startsWith(resolveOpenCodeManagedServersLogDir(logsDir))).toBe(true);

    capture.write('stdout', 'first line\nsecond ');
    capture.write('stdout', 'line\n');
    capture.write('stderr', 'an error happened\n');
    capture.recordTrackedPid(48123);
    await capture.close();

    const content = await readFile(capture.logPath, 'utf8');
    expect(content).toContain('# OpenCode managed server log');
    expect(content).toContain('# command: opencode serve --hostname=127.0.0.1 --port=50842');
    expect(content).toContain('# baseUrl: http://127.0.0.1:50842');
    expect(content).toContain('# spawnPid: 12143');
    expect(content).toContain('# launchFingerprint: fp-abc');
    expect(content).toContain('# trackedPid: 48123');
    expect(content).toContain('[stdout] first line');
    expect(content).toContain('[stdout] second line');
    expect(content).toContain('[stderr] an error happened');
    // No env values / tokens.
    expect(content).not.toContain('OPENCODE_AUTH_CONTENT');
  });
});
