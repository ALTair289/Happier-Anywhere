import { describe, expect, it } from 'vitest';

import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { resolveClaudeRemoteLaunchErrorDisposition } from './claudeRemoteLauncher';

describe('Claude remote launch error disposition', () => {
  it('does not surface an Agent SDK child exit after runtime termination has started', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: true,
    })).toBe('terminate');
  });

  it('still surfaces the same child exit when runtime termination was not requested', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: false,
    })).toBe('surface');
  });

  it('preserves launcher-owned switch and exit teardown', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: 'switch',
      runtimeTerminationStarted: false,
    })).toBe('ignore');
  });

  it('reads the canonical deferred-session termination fence without requiring an attached client', () => {
    const client = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-termination-disposition',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    expect(client.hasRuntimeTerminationStarted()).toBe(false);
    client.beginRuntimeTermination();
    expect(client.hasRuntimeTerminationStarted()).toBe(true);
  });
});
