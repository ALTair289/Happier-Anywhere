import { describe, expect, it, vi } from 'vitest';

import { interruptClaudeUnifiedQueuedPrompt } from './interruptClaudeUnifiedQueuedPrompt';

function queuedScreen(extra = ''): string {
  return [
    '✽ Working… (2m 10s · ↓ 1.2k tokens)',
    '❯',
    'Press up to edit queued messages',
    extra,
  ].filter(Boolean).join('\n');
}

describe('interruptClaudeUnifiedQueuedPrompt', () => {
  it('sends exactly one interrupt and no prompt bytes after fresh exact custody proof', async () => {
    const interruptTurn = vi.fn(async () => undefined);
    const claim = vi.fn(() => true);
    const result = await interruptClaudeUnifiedQueuedPrompt({
      localId: 'queued-local',
      readCurrentLocalId: () => 'queued-local',
      claim,
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: queuedScreen(),
        observedAt: 10_000,
      })),
      interruptTurn,
    });

    expect(result).toEqual({ ok: true, status: 'interrupted' });
    expect(claim).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledWith('queued-local');
    expect(interruptTurn).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing queued banner', '✽ Working… (2m 10s · ↓ 1.2k tokens)\n❯'],
    ['composer draft', queuedScreen('❯ do not merge this draft')],
    ['dialog ambiguity', `${queuedScreen()}\nChange effort level?\n❯ 1. Yes\n  2. No`],
  ])('writes zero bytes for %s', async (_name, currentInput) => {
    const claim = vi.fn(() => true);
    const interruptTurn = vi.fn(async () => undefined);
    const result = await interruptClaudeUnifiedQueuedPrompt({
      localId: 'queued-local',
      readCurrentLocalId: () => 'queued-local',
      claim,
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput,
        observedAt: 10_000,
      })),
      interruptTurn,
    });

    expect(result).toMatchObject({ ok: false, status: 'not_safe' });
    expect(claim).not.toHaveBeenCalled();
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it('writes zero bytes when the clicked row is stale or the one-shot claim lost a race', async () => {
    const captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: queuedScreen(),
      observedAt: 10_000,
    }));
    const interruptTurn = vi.fn(async () => undefined);

    await expect(interruptClaudeUnifiedQueuedPrompt({
      localId: 'clicked-local',
      readCurrentLocalId: () => 'other-local',
      claim: vi.fn(() => false),
      captureInputState,
      interruptTurn,
    })).resolves.toMatchObject({ ok: false, status: 'stale_state' });
    expect(captureInputState).not.toHaveBeenCalled();

    await expect(interruptClaudeUnifiedQueuedPrompt({
      localId: 'clicked-local',
      readCurrentLocalId: () => 'clicked-local',
      claim: vi.fn(() => false),
      captureInputState,
      interruptTurn,
    })).resolves.toMatchObject({ ok: false, status: 'stale_state' });
    expect(interruptTurn).not.toHaveBeenCalled();
  });
});
