import { describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { runAutomationAsNewSession } from './automationRunNewSession';

describe('runAutomationAsNewSession', () => {
  it('uses stable launch identity and explicit child-owned first-input custody', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success' as const,
      sessionId: 'session-automation',
    }));

    await runAutomationAsNewSession({
      spawnSession,
      runId: 'run-new-prompt',
      firstInputText: 'Inspect this workspace.',
      template: { directory: '/tmp/happier-automation' },
    });

    const firstOptions = spawnSession.mock.calls[0]?.[0];
    expect(firstOptions).toEqual(expect.objectContaining({
      directory: '/tmp/happier-automation',
      spawnNonce: 'automation:run-new-prompt',
      pendingFirstInput: expect.objectContaining({
        text: 'Inspect this workspace.',
        localId: expect.stringMatching(/^spawn-first:/),
      }),
    }));
    expect(firstOptions).not.toHaveProperty('initialPrompt');

    await runAutomationAsNewSession({
      spawnSession,
      runId: 'run-new-prompt',
      firstInputText: 'Inspect this workspace.',
      template: { directory: '/tmp/happier-automation' },
    });
    expect(spawnSession.mock.calls[1]?.[0].pendingFirstInput).toEqual(firstOptions?.pendingFirstInput);
  });

  it('does not create an empty first-input handoff', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success' as const,
      sessionId: 'session-automation',
    }));

    await runAutomationAsNewSession({
      spawnSession,
      runId: 'run-without-prompt',
      firstInputText: '   ',
      template: { directory: '/tmp/happier-automation' },
    });

    expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('pendingFirstInput');
  });
});
