import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { withSessionHandoffPrepareTargetJobLeaseOperationLock } from './sessionHandoffPrepareTargetJobLeaseOperationLock';

describe('withSessionHandoffPrepareTargetJobLeaseOperationLock', () => {
  it.each(['', '.', '..', 'nested/job', 'nested\\job'])(
    'rejects non-isolated job id %j before entering the operation',
    async (jobId) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-operation-lock-invalid-id-'));
      const operation = vi.fn(async () => 'must-not-run');
      try {
        await expect(withSessionHandoffPrepareTargetJobLeaseOperationLock({
          activeServerDir,
          jobId,
        }, operation)).rejects.toThrow('Invalid session handoff prepare-target job id');
        expect(operation).not.toHaveBeenCalled();
      } finally {
        await rm(activeServerDir, { recursive: true, force: true });
      }
    },
  );

  it('preserves opaque job ids containing non-special dots', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-operation-lock-dotted-id-'));
    try {
      await expect(withSessionHandoffPrepareTargetJobLeaseOperationLock({
        activeServerDir,
        jobId: 'prepare.valid_job-1',
      }, async () => 'entered')).resolves.toBe('entered');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
