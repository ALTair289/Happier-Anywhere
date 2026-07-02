import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { startManagedOpenCodeServer } from './openCodeManagedServer';

describe('startManagedOpenCodeServer (exit before ready)', () => {
  it('includes signal and a no-output marker when the child exits without stdout/stderr', async () => {
    const prevCmd = process.env.HAPPIER_OPENCODE_PATH;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-managed-exit-'));
    const scriptPath = join(dir, 'fake-opencode');
    try {
      await writeFile(
        scriptPath,
        `#!/usr/bin/env node
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10);
`,
        'utf8',
      );
      await chmod(scriptPath, 0o755);
      process.env.HAPPIER_OPENCODE_PATH = scriptPath;

      let errorMessage = '';
      try {
        await startManagedOpenCodeServer({ timeoutMs: 5_000, logsDir: join(dir, 'logs') });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toMatch(/signal=/);
      expect(errorMessage).toMatch(/no output captured/i);
      expect(errorMessage).toContain('Output:\n<no output captured>');
      expect(errorMessage).not.toContain('Output:\\n<no output captured>');
      // The startup-failure error references the durable log path for diagnosis.
      expect(errorMessage).toContain(join(dir, 'logs', 'opencode-managed-servers'));
    } finally {
      fetchSpy.mockRestore();
      if (prevCmd === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
      else process.env.HAPPIER_OPENCODE_PATH = prevCmd;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
