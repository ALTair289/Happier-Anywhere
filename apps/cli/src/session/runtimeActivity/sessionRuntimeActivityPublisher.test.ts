import { describe, expect, it, vi } from 'vitest';

import {
  createSessionRuntimeActivityPublisher,
  type RuntimeActivityProjectionWriter,
} from './sessionRuntimeActivityPublisher';

function createHarness() {
  const writes: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
  const writer = vi.fn<RuntimeActivityProjectionWriter>(async (projection) => {
    writes.push(projection);
  });
  const publisher = createSessionRuntimeActivityPublisher({
    nowMs: () => 1_000,
    leaseDurationMs: 5_000,
    updateRuntimeActivityProjection: writer,
  });

  return { publisher, writer, writes };
}

describe('createSessionRuntimeActivityPublisher', () => {
  it('writes absolute public aggregates on source start and clear', async () => {
    const { publisher, writes } = createHarness();

    await publisher.setSourceActive({
      id: 'claude-task-1',
      sourceClass: 'provider_detached_task',
    });
    await publisher.clearSource('claude-task-1', 'task_terminal');

    expect(writes).toEqual([
      {
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 1_000,
        runtimeActivityExpiresAt: 6_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
      {
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityExpiresAt: null,
        runtimeActivitySourceClass: null,
      },
    ]);
  });

  it('clearAll is idempotent and always writes the idle projection', async () => {
    const { publisher, writes } = createHarness();

    await publisher.clearAll('dispose');
    await publisher.clearAll('dispose');

    expect(writes).toEqual([
      {
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityExpiresAt: null,
        runtimeActivitySourceClass: null,
      },
      {
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityExpiresAt: null,
        runtimeActivitySourceClass: null,
      },
    ]);
  });

  it('does not write projection updates when clearing sources that were not active', async () => {
    const { publisher, writes } = createHarness();

    await publisher.clearSource('unknown-source', 'terminal_notification');
    await publisher.clearProviderSources('unknown-provider', 'provider_disconnect');

    expect(writes).toEqual([]);
  });

  it('does not create activity from source observations for unknown sources', async () => {
    const { publisher, writes } = createHarness();

    await publisher.observeSource({ id: 'unknown-source', reason: 'historical_jsonl_import' });

    expect(writes).toEqual([]);
    expect(publisher.getProjection()).toEqual({
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: null,
    });
  });

  it('collapses mixed active source classes without exposing source ids', async () => {
    const { publisher, writes } = createHarness();

    await publisher.setSourceActive({ id: 'task-1', sourceClass: 'provider_detached_task' });
    await publisher.setSourceActive({ id: 'autonomous-1', sourceClass: 'provider_autonomous_output' });

    expect(writes.at(-1)).toEqual({
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 6_000,
      runtimeActivitySourceClass: 'mixed',
    });
    expect(JSON.stringify(writes.at(-1))).not.toContain('task-1');
    expect(JSON.stringify(writes.at(-1))).not.toContain('autonomous-1');
  });

  it('ignores active sources that do not have a valid future projection lease', async () => {
    const writer = vi.fn<RuntimeActivityProjectionWriter>();
    const publisher = createSessionRuntimeActivityPublisher({
      nowMs: () => 1_000,
      leaseDurationMs: 5_000,
      updateRuntimeActivityProjection: writer,
    });

    await publisher.setSourceActive({
      id: 'expired-source',
      sourceClass: 'provider_detached_task',
      observedAtMs: 500,
      expiresAtMs: 900,
    });
    await publisher.setSourceActive({
      id: 'valid-source',
      sourceClass: 'provider_detached_task',
      observedAtMs: 700,
      expiresAtMs: 2_000,
    });

    expect(writer).toHaveBeenLastCalledWith({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 700,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
  });

  it('renews leases only from source-keyed observations and treats ambient liveness as a no-op', async () => {
    let nowMs = 1_000;
    const writes: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
    const publisher = createSessionRuntimeActivityPublisher({
      nowMs: () => nowMs,
      leaseDurationMs: 5_000,
      updateRuntimeActivityProjection: async (projection) => {
        writes.push(projection);
      },
    });

    await publisher.setSourceActive({ id: 'task-1', sourceClass: 'provider_detached_task' });
    nowMs = 4_000;
    await publisher.observeAmbientLiveness('sdk_query_open');
    await publisher.observeSource({ id: 'task-1', reason: 'task_progress' });

    expect(writes).toEqual([
      {
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 1_000,
        runtimeActivityExpiresAt: 6_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
      {
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 4_000,
        runtimeActivityExpiresAt: 9_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
    ]);
  });

  it('coalesces early source-keyed renewals while still publishing near-expiry renewals', async () => {
    let nowMs = 1_000;
    const writes: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
    const publisher = createSessionRuntimeActivityPublisher({
      nowMs: () => nowMs,
      leaseDurationMs: 10_000,
      updateRuntimeActivityProjection: async (projection) => {
        writes.push(projection);
      },
    });

    await publisher.setSourceActive({ id: 'task-1', sourceClass: 'provider_detached_task' });
    nowMs = 3_000;
    await publisher.observeSource({ id: 'task-1', reason: 'task_progress' });
    await publisher.setSourceActive({ id: 'task-1', sourceClass: 'provider_detached_task' });
    nowMs = 7_000;
    await publisher.observeSource({ id: 'task-1', reason: 'task_progress' });

    expect(writes).toEqual([
      {
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 1_000,
        runtimeActivityExpiresAt: 11_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
      {
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 7_000,
        runtimeActivityExpiresAt: 17_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
    ]);
  });

  it('does not write unchanged source observations that leave the public aggregate identical', async () => {
    const { publisher, writes } = createHarness();

    await publisher.setSourceActive({ id: 'task-1', sourceClass: 'provider_detached_task' });
    await publisher.observeSource({ id: 'task-1', reason: 'task_progress', observedAtMs: 1_000, expiresAtMs: 6_000 });

    expect(writes).toEqual([
      {
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 1_000,
        runtimeActivityExpiresAt: 6_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
    ]);
  });

  it('does not invent a provider-work timeout while source-keyed renewals continue', async () => {
    let nowMs = 1_000;
    const writes: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
    const longRunningPublisher = createSessionRuntimeActivityPublisher({
      nowMs: () => nowMs,
      leaseDurationMs: 5_000,
      updateRuntimeActivityProjection: async (projection) => {
        writes.push(projection);
      },
    });

    await longRunningPublisher.setSourceActive({ id: 'task-1', sourceClass: 'provider_detached_task' });
    nowMs = 3_601_000;
    await longRunningPublisher.observeSource({ id: 'task-1', reason: 'task_progress' });

    expect(writes.at(-1)).toEqual({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 3_601_000,
      runtimeActivityExpiresAt: 3_606_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
  });

  it('keeps a live owned source active after its public projection lease elapses until it is explicitly cleared', async () => {
    let nowMs = 1_000;
    const writes: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
    const publisher = createSessionRuntimeActivityPublisher({
      nowMs: () => nowMs,
      leaseDurationMs: 5_000,
      updateRuntimeActivityProjection: async (projection) => {
        writes.push(projection);
      },
    });

    await publisher.setSourceActive({ id: 'task-1', sourceClass: 'provider_detached_task' });
    nowMs = 7_000;

    expect(publisher.getProjection()).toEqual({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 6_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    expect(publisher.getSnapshot().activeCount).toBe(1);

    await publisher.clearSource('task-1', 'task_terminal');

    expect(writes.at(-1)).toEqual({
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: null,
    });
  });

  it('reconciliation preserves existing staleness instead of freshening phantom sources', async () => {
    let nowMs = 10_000;
    const writes: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
    const publisher = createSessionRuntimeActivityPublisher({
      nowMs: () => nowMs,
      leaseDurationMs: 5_000,
      updateRuntimeActivityProjection: async (projection) => {
        writes.push(projection);
      },
    });

    await publisher.reconcileSources({
      reason: 'runner_reconnect',
      sources: [
        {
          id: 'stale-task',
          sourceClass: 'provider_detached_task',
          observedAtMs: 1_000,
          expiresAtMs: 2_000,
        },
      ],
    });

    expect(writes).toEqual([
      {
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityExpiresAt: null,
        runtimeActivitySourceClass: null,
      },
    ]);
    expect(publisher.getSnapshot().sources[0]).toMatchObject({
      id: 'stale-task',
      lastObservedAtMs: 1_000,
      expiresAtMs: 2_000,
      status: 'stale',
    });
  });

  it('reconciliation can preserve one live source while carrying forward another stale source', async () => {
    const { publisher, writes } = createHarness();

    await publisher.reconcileSources({
      reason: 'runner_reconnect',
      sources: [
        {
          id: 'stale-task',
          sourceClass: 'provider_detached_task',
          observedAtMs: 500,
          expiresAtMs: 900,
        },
        {
          id: 'live-task',
          sourceClass: 'provider_detached_task',
          observedAtMs: 700,
          expiresAtMs: 2_000,
        },
      ],
    });

    expect(writes).toEqual([
      {
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 700,
        runtimeActivityExpiresAt: 2_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
    ]);
    expect(publisher.getSnapshot().sources.map((source) => [source.id, source.status])).toEqual([
      ['live-task', 'active'],
      ['stale-task', 'stale'],
    ]);
  });

  it('logs projection write failures without calling foreground lifecycle or keepalive paths', async () => {
    const logError = vi.fn();
    const forbidden = {
      keepAlive: vi.fn(),
      sendAgentMessage: vi.fn(),
      updateThinking: vi.fn(),
      recordMeaningfulActivity: vi.fn(),
    };
    const publisher = createSessionRuntimeActivityPublisher({
      nowMs: () => 1_000,
      leaseDurationMs: 5_000,
      updateRuntimeActivityProjection: async () => {
        throw new Error('socket unavailable');
      },
      logError,
      lifecycle: forbidden,
    });

    await expect(publisher.setSourceActive({
      id: 'task-1',
      sourceClass: 'provider_detached_task',
    })).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      'runtime_activity_projection_write_failed',
      expect.objectContaining({ reason: 'source_active' }),
    );
    expect(forbidden.keepAlive).not.toHaveBeenCalled();
    expect(forbidden.sendAgentMessage).not.toHaveBeenCalled();
    expect(forbidden.updateThinking).not.toHaveBeenCalled();
    expect(forbidden.recordMeaningfulActivity).not.toHaveBeenCalled();
  });

  it('retries a failed active projection write without waiting for another source event', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const writes: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
      const publisher = createSessionRuntimeActivityPublisher({
        nowMs: () => 1_000,
        leaseDurationMs: 5_000,
        updateRuntimeActivityProjection: async (projection) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('socket temporarily unavailable');
          }
          writes.push(projection);
        },
      });

      await publisher.setSourceActive({
        id: 'workflow-task-1',
        sourceClass: 'provider_detached_task',
      });

      expect(writes).toEqual([]);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(writes).toEqual([
        {
          runtimeActivityActiveCount: 1,
          runtimeActivityObservedAt: 1_000,
          runtimeActivityExpiresAt: 6_000,
          runtimeActivitySourceClass: 'provider_detached_task',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes overlapping source writes so a stale active projection cannot land after a clear', async () => {
    let releaseActiveWrite!: () => void;
    const activeWrite = new Promise<void>((resolve) => {
      releaseActiveWrite = resolve;
    });
    const applied: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
    const writer = vi.fn<RuntimeActivityProjectionWriter>(async (projection) => {
      if (writer.mock.calls.length === 1) {
        await activeWrite;
      }
      applied.push(projection);
    });
    const publisher = createSessionRuntimeActivityPublisher({
      nowMs: () => 1_000,
      leaseDurationMs: 5_000,
      updateRuntimeActivityProjection: writer,
    });

    const activePromise = publisher.setSourceActive({
      id: 'task-1',
      sourceClass: 'provider_detached_task',
    });
    await vi.waitFor(() => {
      expect(writer).toHaveBeenCalledTimes(1);
    });

    const clearPromise = publisher.clearSource('task-1', 'task_terminal');
    await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(1);

    releaseActiveWrite();
    await Promise.all([activePromise, clearPromise]);

    expect(applied).toEqual([
      {
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 1_000,
        runtimeActivityExpiresAt: 6_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
      {
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityExpiresAt: null,
        runtimeActivitySourceClass: null,
      },
    ]);
  });
});
