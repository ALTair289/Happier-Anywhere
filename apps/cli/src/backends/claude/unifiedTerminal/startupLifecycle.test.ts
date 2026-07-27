import { describe, expect, it, vi } from 'vitest';

import { prepareClaudeUnifiedStartupLifecycle } from './startupLifecycle';

describe('prepareClaudeUnifiedStartupLifecycle', () => {
  it('keeps preparation inert and opens the canonical resume barrier once when provider launch starts', async () => {
    let releaseBarrier: (() => void) | undefined;
    const binding = {
      recordProviderResumeStarted: vi.fn(() => new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      })),
      recordProviderResumeSessionStarted: vi.fn(),
      recordProviderStartupReady: vi.fn(async () => undefined),
    };
    let prepared = false;

    const preparing = prepareClaudeUnifiedStartupLifecycle({
      intent: { kind: 'resume_native', providerSessionId: 'resume-1' },
      binding,
    }).then((value) => {
      prepared = true;
      return value;
    });

    await Promise.resolve();
    expect(binding.recordProviderResumeStarted).not.toHaveBeenCalled();
    expect(prepared).toBe(true);

    const callbacks = await preparing;
    const firstLaunchStart = callbacks.onProviderLaunchStarting();
    const secondLaunchStart = callbacks.onProviderLaunchStarting();
    await Promise.resolve();
    expect(binding.recordProviderResumeStarted).toHaveBeenCalledTimes(1);
    expect(binding.recordProviderResumeStarted).toHaveBeenCalledWith({
      kind: 'resume_native',
      providerSessionId: 'resume-1',
    });

    releaseBarrier?.();
    await Promise.all([firstLaunchStart, secondLaunchStart]);
    callbacks.onProviderSessionStarted();
    await callbacks.onStartupReady();

    expect(binding.recordProviderResumeSessionStarted).toHaveBeenCalledTimes(1);
    expect(binding.recordProviderStartupReady).toHaveBeenCalledTimes(1);
  });

  it('does not manufacture a foreground barrier for a new provider session', async () => {
    const binding = {
      recordProviderResumeStarted: vi.fn(async () => undefined),
      recordProviderResumeSessionStarted: vi.fn(),
      recordProviderStartupReady: vi.fn(async () => undefined),
    };

    const callbacks = await prepareClaudeUnifiedStartupLifecycle({
      intent: { kind: 'new_session' },
      binding,
    });

    expect(binding.recordProviderResumeStarted).not.toHaveBeenCalled();
    await callbacks.onProviderLaunchStarting();
    expect(binding.recordProviderResumeStarted).not.toHaveBeenCalled();
    callbacks.onProviderSessionStarted();
    await callbacks.onStartupReady();
    expect(binding.recordProviderResumeSessionStarted).toHaveBeenCalledTimes(1);
    expect(binding.recordProviderStartupReady).toHaveBeenCalledTimes(1);
  });

  it('awaits the same canonical barrier for an explicit native continue without inventing an id', async () => {
    const binding = {
      recordProviderResumeStarted: vi.fn(async () => undefined),
      recordProviderResumeSessionStarted: vi.fn(),
      recordProviderStartupReady: vi.fn(async () => undefined),
    };

    const callbacks = await prepareClaudeUnifiedStartupLifecycle({
      intent: { kind: 'continue_native' },
      binding,
    });

    expect(binding.recordProviderResumeStarted).not.toHaveBeenCalled();
    await callbacks.onProviderLaunchStarting();
    expect(binding.recordProviderResumeStarted).toHaveBeenCalledWith({ kind: 'continue_native' });
  });
});
