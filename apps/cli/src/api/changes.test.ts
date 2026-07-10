import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

vi.mock('axios');

describe('fetchChanges', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses the live runtime env endpoint instead of stale loaded configuration', async () => {
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:41001');
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', '');
    vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', '');
    await import('@/configuration');

    vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:52002');
    (axios.get as any).mockResolvedValue({
      status: 200,
      data: {
        changes: [],
        nextCursor: 0,
      },
    });

    const { fetchChanges } = await import('./changes');

    await fetchChanges({ token: 't', after: 0 });

    expect((axios.get as any).mock.calls[0]?.[0]).toBe('http://127.0.0.1:52002/v2/changes');
  });

  it('parses ok response', async () => {
    const { fetchChanges } = await import('./changes');
    (axios.get as any).mockResolvedValue({
      status: 200,
      data: {
        changes: [{ cursor: 1, kind: 'session', entityId: 's1', changedAt: Date.now(), hint: null }],
        nextCursor: 1,
      },
    });

    const result = await fetchChanges({ token: 't', after: 0 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.response.nextCursor).toBe(1);
    expect(result.response.changes).toHaveLength(1);
  });

  it('parses cursor-gone (410)', async () => {
    const { fetchChanges } = await import('./changes');
    (axios.get as any).mockResolvedValue({
      status: 410,
      data: { error: 'cursor-gone', currentCursor: 42 },
    });

    const result = await fetchChanges({ token: 't', after: 999 });
    expect(result).toEqual({ status: 'cursor-gone', currentCursor: 42 });
  });

  it('returns error when /v2/changes is missing (e.g. old server 404)', async () => {
    const { fetchChanges } = await import('./changes');
    (axios.get as any).mockResolvedValue({
      status: 404,
      data: { error: 'not-found' },
    });

    const result = await fetchChanges({ token: 't', after: 0 });
    expect(result.status).toBe('error');
  });

  it.each([401, 403] as const)('returns canonical not_authenticated error for auth status %i', async (status) => {
    const [{ fetchChanges }, { HttpStatusError }] = await Promise.all([
      import('./changes'),
      import('./client/httpStatusError'),
    ]);
    (axios.get as any).mockResolvedValue({
      status,
      data: { error: 'not-authenticated' },
    });

    const result = await fetchChanges({ token: 't', after: 0 });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.error).toBeInstanceOf(HttpStatusError);
    expect(result.error).toMatchObject({
      code: 'not_authenticated',
      response: { status },
    });
  });
});
