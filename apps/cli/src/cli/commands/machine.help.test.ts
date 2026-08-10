import { describe, expect, it, vi } from 'vitest';

import { handleMachineCommand } from './machine';
import type { MachineCommandDeps } from './machine';

describe('happier machine --help', () => {
  it('prints usage without touching the system task runner', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: Partial<MachineCommandDeps> = {
      createRunner: () => ({
        start: vi.fn(async () => ({ taskId: 'unused' })),
        poll: vi.fn(async () => ({ events: [], nextCursor: 0, result: null, pendingPrompt: null })),
        respond: vi.fn(async () => undefined),
      }),
    };

    try {
      await handleMachineCommand(['--help'], deps);

      expect(deps.createRunner?.().start).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier machine');
      expect(output).toContain('happier machine setup');
      expect(output).toContain('--cli-payload <extracted-root>');
      expect(output).toContain('--cli-payload-sha256 <sha256>');
      expect(output).toContain('local path on the Controller');
    } finally {
      logSpy.mockRestore();
    }
  });
});
