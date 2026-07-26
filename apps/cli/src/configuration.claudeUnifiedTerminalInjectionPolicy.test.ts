import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_LIMIT',
  'HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_BASE_DELAY_MS',
  'HAPPIER_CLAUDE_UNIFIED_TERMINAL_PROVIDER_ACCEPTANCE_TIMEOUT_MS',
]);

describe('configuration Claude unified terminal injection policy', () => {
  afterEach(() => {
    envScope.restore();
    vi.resetModules();
  });

  it('defaults injection retry to bounded values without a provider-acceptance timeout authority', async () => {
    delete process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_LIMIT;
    delete process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_BASE_DELAY_MS;
    delete process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_PROVIDER_ACCEPTANCE_TIMEOUT_MS;
    vi.resetModules();

    const { configuration } = await import('./configuration');

    expect(configuration.claudeUnifiedTerminalInjectionRetryLimit).toBe(3);
    expect(configuration.claudeUnifiedTerminalInjectionRetryBaseDelayMs).toBe(250);
    expect('claudeUnifiedTerminalProviderAcceptanceTimeoutMs' in configuration).toBe(false);
  });

  it('reads injection retry from env with bounds and ignores the retired provider-acceptance timeout env', async () => {
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_LIMIT = '5';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_BASE_DELAY_MS = '123';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_PROVIDER_ACCEPTANCE_TIMEOUT_MS = '4567';
    vi.resetModules();
    const { configuration } = await import('./configuration');

    expect(configuration.claudeUnifiedTerminalInjectionRetryLimit).toBe(5);
    expect(configuration.claudeUnifiedTerminalInjectionRetryBaseDelayMs).toBe(123);
    expect('claudeUnifiedTerminalProviderAcceptanceTimeoutMs' in configuration).toBe(false);

    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_LIMIT = '-1';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_BASE_DELAY_MS = '0';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_PROVIDER_ACCEPTANCE_TIMEOUT_MS = '0';
    vi.resetModules();
    const { configuration: invalidConfiguration } = await import('./configuration');

    expect(invalidConfiguration.claudeUnifiedTerminalInjectionRetryLimit).toBe(3);
    expect(invalidConfiguration.claudeUnifiedTerminalInjectionRetryBaseDelayMs).toBe(250);
    expect('claudeUnifiedTerminalProviderAcceptanceTimeoutMs' in invalidConfiguration).toBe(false);

    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_LIMIT = '100';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_INJECTION_RETRY_BASE_DELAY_MS = '60001';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_PROVIDER_ACCEPTANCE_TIMEOUT_MS = '180001';
    vi.resetModules();
    const { configuration: clampedConfiguration } = await import('./configuration');

    expect(clampedConfiguration.claudeUnifiedTerminalInjectionRetryLimit).toBe(10);
    expect(clampedConfiguration.claudeUnifiedTerminalInjectionRetryBaseDelayMs).toBe(60_000);
    expect('claudeUnifiedTerminalProviderAcceptanceTimeoutMs' in clampedConfiguration).toBe(false);
  });
});
