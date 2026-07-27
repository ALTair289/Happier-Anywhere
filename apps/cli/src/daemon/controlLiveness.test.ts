import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeDaemonAuthenticatedControl } from './controlLiveness';

describe('probeDaemonAuthenticatedControl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats only ESRCH as definitive PID absence', async () => {
    const pidError = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw pidError; });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeDaemonAuthenticatedControl({
      pid: 43210,
      httpPort: 43213,
      controlToken: 'token-123',
      timeoutMs: 1_000,
    })).resolves.toBe('pid_not_running');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['EPERM', 'EPERM'],
    ['unknown error', undefined],
  ] as const)('keeps an inconclusive %s PID probe fail-closed', async (_label, code) => {
    const pidError = Object.assign(new Error('inconclusive PID liveness'), { code });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw pidError; });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeDaemonAuthenticatedControl({
      pid: 43210,
      httpPort: 43213,
      controlToken: 'token-123',
      timeoutMs: 1_000,
    })).resolves.toBe('unreachable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'unreachable'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'unreachable'],
    [429, 'unreachable'],
    [500, 'unreachable'],
    [503, 'unreachable'],
  ] as const)('classifies HTTP %s as %s', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));

    await expect(probeDaemonAuthenticatedControl({
      pid: process.pid,
      httpPort: 43213,
      controlToken: 'token-123',
      timeoutMs: 1_000,
    })).resolves.toBe(expected);
  });
});
