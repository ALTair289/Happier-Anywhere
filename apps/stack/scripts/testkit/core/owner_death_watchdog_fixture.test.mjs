import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitForOwnerDeathWatchdogQuiescence } from './owner_death_watchdog_fixture.mjs';

async function withFixture(t) {
  const storageDir = await mkdtemp(join(tmpdir(), 'hstack-owner-watchdog-fixture-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  return { storageDir, stackName: 'test-stack' };
}

test('watchdog fixture cleanup returns when startup published no runtime or watchdog artifacts', async (t) => {
  const fixture = await withFixture(t);
  await waitForOwnerDeathWatchdogQuiescence({ ...fixture, timeoutMs: 100 });
});

test('watchdog fixture cleanup accepts non-destructive terminal outcomes', async (t) => {
  const fixture = await withFixture(t);
  const stackDir = join(fixture.storageDir, fixture.stackName);
  await mkdir(join(stackDir, 'logs'), { recursive: true });
  await writeFile(join(stackDir, 'stack.runtime.json'), '{}\n', 'utf8');
  await writeFile(
    join(stackDir, 'logs', 'owner-death-watchdog.log'),
    '[watchdog] runtime stop not authorized (successor_owner_incarnation); no-op\n',
    'utf8',
  );
  await waitForOwnerDeathWatchdogQuiescence({ ...fixture, timeoutMs: 100 });
});

test('watchdog fixture cleanup still waits for a non-terminal active watchdog', async (t) => {
  const fixture = await withFixture(t);
  const stackDir = join(fixture.storageDir, fixture.stackName);
  await mkdir(join(stackDir, 'logs'), { recursive: true });
  await writeFile(join(stackDir, 'stack.runtime.json'), '{}\n', 'utf8');
  await writeFile(join(stackDir, 'logs', 'owner-death-watchdog.log'), '[watchdog] watching owner pid=123\n', 'utf8');
  await assert.rejects(
    () => waitForOwnerDeathWatchdogQuiescence({ ...fixture, timeoutMs: 50 }),
    /timed out waiting for owner-death watchdog quiescence/,
  );
});
