import {
  settleSpawnSessionNonce,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';

import { fetchJson } from '../http';

export async function daemonControlPostJson<T = any>(params: {
  port: number;
  path: string;
  body?: any;
  timeoutMs?: number;
  controlToken?: string | null;
}): Promise<{ status: number; data: T }> {
  const defaultTimeoutMs = params.path === '/spawn-session' ? 90_000 : 30_000;
  try {
    const res = await fetchJson<T>(`http://127.0.0.1:${params.port}${params.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(typeof params.controlToken === 'string' && params.controlToken.length > 0
          ? { 'x-happier-daemon-token': params.controlToken }
          : {}),
      },
      body: JSON.stringify(params.body ?? {}),
      timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
    });
    return { status: res.status, data: res.data };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`daemonControlPostJson failed (port=${params.port} path=${params.path}): ${reason}`);
  }
}

export async function resolveDaemonSpawnSessionId(params: Readonly<{
  port: number;
  controlToken?: string | null;
  immediateSessionId?: string;
  spawnNonce?: string;
  timeoutMs?: number;
}>): Promise<string> {
  const immediateSessionId = params.immediateSessionId?.trim() ?? '';
  if (immediateSessionId) return immediateSessionId;

  const spawnNonce = params.spawnNonce?.trim() ?? '';
  if (!spawnNonce) throw new Error('Missing sessionId and spawnNonce from daemon spawn-session');

  const timeoutMs = params.timeoutMs ?? 45_000;
  const settled = await settleSpawnSessionNonce({
    spawnNonce,
    timeoutMs,
    pollIntervalMs: 50,
    resolve: async (nonce): Promise<SpawnSessionNonceResolution> => {
      const resolved = await daemonControlPostJson<{
        success: true;
        status: 'success' | 'pending' | 'not_found' | 'unsupported';
        sessionId?: string;
      }>({
        port: params.port,
        path: '/spawn-session/resolve',
        controlToken: params.controlToken,
        body: { spawnNonce: nonce },
        timeoutMs: 5_000,
      });
      if (resolved.status !== 200 || resolved.data.success !== true) {
        throw new Error(`spawn-session/resolve failed (status=${resolved.status})`);
      }
      if (resolved.data.status !== 'success') {
        return { status: resolved.data.status };
      }
      return {
        status: 'success',
        sessionId: resolved.data.sessionId ?? '',
      };
    },
  });
  if (settled.status === 'success') {
    return settled.sessionId;
  }
  if (settled.status === 'not_found') {
    throw new Error(`spawn-session/resolve lost spawn nonce ${spawnNonce}`);
  }
  if (settled.status === 'unsupported') {
    throw new Error('spawn-session/resolve is unsupported by this daemon');
  }
  throw new Error(`Timed out resolving daemon spawn nonce ${spawnNonce}`);
}
