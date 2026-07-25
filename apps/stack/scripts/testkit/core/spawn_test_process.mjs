import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { terminateProcessGroup } from '../../utils/proc/terminate.mjs';

export function spawnTestProcess(command, args = [], options = {}) {
  const child = spawn(command, [...args], {
    stdio: 'ignore',
    ...options,
  });

  if (!child.pid) {
    throw new Error('Failed to spawn test process');
  }

  return child;
}

export function spawnDetachedTestProcess(command, args = [], options = {}) {
  const child = spawnTestProcess(command, args, {
    detached: true,
    ...options,
  });
  child.unref();
  return child;
}

export function spawnDetachedInlineNodeTestProcess(source, options = {}) {
  return spawnDetachedTestProcess(process.execPath, ['-e', source], options);
}

export async function terminateDetachedTestProcess(child, { graceMs = 500 } = {}) {
  if (!child) return;
  const exit = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : once(child, 'exit').then(() => undefined);
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    await terminateProcessGroup(child.pid, { graceMs, signal: 'SIGTERM' });
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already exited
    }
  }
  await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(resolve, Math.max(100, graceMs))),
  ]);
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
