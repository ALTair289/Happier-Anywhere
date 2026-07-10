import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_CLAUDE_UNIFIED_TERMINAL_HOST_ACTION_TIMEOUT_MS',
]);

describe('configuration claudeUnifiedTerminalHostActionTimeoutMs', () => {
  afterEach(() => {
    envScope.restore();
    vi.resetModules();
  });

  it('defaults zellij terminal host actions to a bounded timeout', async () => {
    delete process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_HOST_ACTION_TIMEOUT_MS;
    vi.resetModules();

    const { configuration } = await import('./configuration');

    expect(configuration.claudeUnifiedTerminalHostActionTimeoutMs).toBe(15_000);
  });

  it('reads the zellij terminal host action timeout from env and applies configured bounds', async () => {
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_HOST_ACTION_TIMEOUT_MS = '1234';
    vi.resetModules();
    const { configuration } = await import('./configuration');
    expect(configuration.claudeUnifiedTerminalHostActionTimeoutMs).toBe(1_234);

    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_HOST_ACTION_TIMEOUT_MS = '1';
    vi.resetModules();
    const { configuration: configuration2 } = await import('./configuration');
    expect(configuration2.claudeUnifiedTerminalHostActionTimeoutMs).toBe(15_000);

    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_HOST_ACTION_TIMEOUT_MS = '60001';
    vi.resetModules();
    const { configuration: configuration3 } = await import('./configuration');
    expect(configuration3.claudeUnifiedTerminalHostActionTimeoutMs).toBe(60_000);
  });
});
