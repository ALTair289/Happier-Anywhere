import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TERMINAL_OWNER_DEATH_WATCHDOG_PATTERN = /(?:sweep complete|sweep failed|runtime state missing; exiting|runtime owner changed to pid=\d+; exiting|successor runtime detected; no-op|runtime stop not authorized \([^\n]+\); no-op|watched owner startedAt (?:missing|invalid); no-op)/;

function readOptionalFile(path) {
  return readFile(path, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}

export async function waitForOwnerDeathWatchdogQuiescence({
  storageDir,
  stackName,
  timeoutMs = 30_000,
} = {}) {
  const stackDir = join(storageDir, stackName);
  const runtimeStatePath = join(stackDir, 'stack.runtime.json');
  const logPath = join(stackDir, 'logs', 'owner-death-watchdog.log');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [runtimeState, contents] = await Promise.all([
      readOptionalFile(runtimeStatePath),
      readOptionalFile(logPath),
    ]);
    // A runner that failed before publishing runtime state never started a watchdog.
    // Do not hide that runner's result behind a cleanup timeout.
    if (runtimeState == null && contents == null) return;
    if (TERMINAL_OWNER_DEATH_WATCHDOG_PATTERN.test(contents ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`timed out waiting for owner-death watchdog quiescence: ${logPath}`);
}
