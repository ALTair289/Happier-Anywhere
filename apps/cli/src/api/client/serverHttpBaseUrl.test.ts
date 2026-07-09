import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVER_ENV_KEYS = [
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
] as const;

function stubServerEnv(values: Partial<Record<typeof SERVER_ENV_KEYS[number], string>>): void {
  for (const key of SERVER_ENV_KEYS) {
    vi.stubEnv(key, values[key] ?? '');
  }
}

describe('resolveServerHttpBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the live runtime env endpoint instead of stale loaded configuration', async () => {
    vi.resetModules();
    stubServerEnv({
      HAPPIER_ACTIVE_SERVER_ID: 'stale-stack',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:41001',
    });

    await import('@/configuration');

    stubServerEnv({
      HAPPIER_ACTIVE_SERVER_ID: 'live-stack',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:52002',
    });

    const { resolveServerHttpBaseUrl } = await import('./serverHttpBaseUrl');

    expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:52002');
  });
});
