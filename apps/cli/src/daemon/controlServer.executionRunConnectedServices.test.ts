import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import {
  deriveConnectedServiceBrokerRefreshToken,
  deriveConnectedServiceRunMaterializeToken,
} from './connectedServices/broker/brokerRefreshCapabilityToken';
import { createDaemonControlApp } from './controlServer';

const CONTROL_TOKEN = 'token';
const RUN_SCOPE_TOKEN = deriveConnectedServiceRunMaterializeToken(CONTROL_TOKEN);
const BROKER_SCOPE_TOKEN = deriveConnectedServiceBrokerRefreshToken(CONTROL_TOKEN);

const MATERIALIZE_PATH = '/connected-service-auth/execution-run/materialize';
const RELEASE_PATH = '/connected-service-auth/execution-run/release';

const MATERIALIZE_PAYLOAD = {
  runId: 'run_1',
  agentId: 'codex',
  pid: 4242,
  materializationKey: 'execution_run:run_1',
  connectedServicesBindingsRaw: {
    v: 1,
    bindingsByServiceId: {
      'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
    },
  },
  sessionDirectory: '/tmp/workspace',
};

const RELEASE_PAYLOAD = {
  runId: 'run_1',
  pid: 4242,
  materializationKey: 'execution_run:run_1',
};

function buildApp(handlers: Record<string, unknown> = {}) {
  return createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine',
    stopSession: async () => false,
    spawnSession: async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'unused',
    }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: CONTROL_TOKEN,
    ...handlers,
  } as Parameters<typeof createDaemonControlApp>[0]);
}

describe('control server execution-run connected-services routes (A2 auth pins)', () => {
  it('rejects the run routes for the broker-refresh scope AND the master token (dedicated run scope only)', async () => {
    const handleExecutionRunConnectedServiceMaterialize = vi.fn(async () => ({ env: {} }));
    const handleExecutionRunConnectedServiceRelease = vi.fn(async () => ({ released: true }));
    const app = buildApp({
      handleExecutionRunConnectedServiceMaterialize,
      handleExecutionRunConnectedServiceRelease,
    });
    try {
      for (const [path, payload] of [
        [MATERIALIZE_PATH, MATERIALIZE_PAYLOAD],
        [RELEASE_PATH, RELEASE_PAYLOAD],
      ] as const) {
        for (const wrongToken of [BROKER_SCOPE_TOKEN, CONTROL_TOKEN, '']) {
          const response = await app.inject({
            method: 'POST',
            url: path,
            headers: wrongToken ? { 'x-happier-daemon-token': wrongToken } : {},
            payload,
          });
          expect(response.statusCode).toBe(401);
        }
      }
      expect(handleExecutionRunConnectedServiceMaterialize).not.toHaveBeenCalled();
      expect(handleExecutionRunConnectedServiceRelease).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 501 with the run-scope token when no handler is wired (fail closed, never a silent 200)', async () => {
    const app = buildApp();
    try {
      const materialize = await app.inject({
        method: 'POST',
        url: MATERIALIZE_PATH,
        headers: { 'x-happier-daemon-token': RUN_SCOPE_TOKEN },
        payload: MATERIALIZE_PAYLOAD,
      });
      expect(materialize.statusCode).toBe(501);
      expect(materialize.json()).toMatchObject({
        ok: false,
        errorCode: 'execution_run_connected_service_materialize_handler_unavailable',
      });

      const release = await app.inject({
        method: 'POST',
        url: RELEASE_PATH,
        headers: { 'x-happier-daemon-token': RUN_SCOPE_TOKEN },
        payload: RELEASE_PAYLOAD,
      });
      expect(release.statusCode).toBe(501);
      expect(release.json()).toMatchObject({
        ok: false,
        errorCode: 'execution_run_connected_service_release_handler_unavailable',
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches to the wired handlers with the run-scope token', async () => {
    const handleExecutionRunConnectedServiceMaterialize = vi.fn(async () => ({
      env: { CODEX_HOME: '/run/root/codex/codex-home' },
    }));
    const handleExecutionRunConnectedServiceRelease = vi.fn(async () => ({ released: true }));
    const app = buildApp({
      handleExecutionRunConnectedServiceMaterialize,
      handleExecutionRunConnectedServiceRelease,
    });
    try {
      const materialize = await app.inject({
        method: 'POST',
        url: MATERIALIZE_PATH,
        headers: { 'x-happier-daemon-token': RUN_SCOPE_TOKEN },
        payload: MATERIALIZE_PAYLOAD,
      });
      expect(materialize.statusCode).toBe(200);
      expect(materialize.json()).toMatchObject({
        ok: true,
        result: { env: { CODEX_HOME: '/run/root/codex/codex-home' } },
      });
      expect(handleExecutionRunConnectedServiceMaterialize).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run_1',
        agentId: 'codex',
        pid: 4242,
        materializationKey: 'execution_run:run_1',
      }));

      const release = await app.inject({
        method: 'POST',
        url: RELEASE_PATH,
        headers: { 'x-happier-daemon-token': RUN_SCOPE_TOKEN },
        payload: RELEASE_PAYLOAD,
      });
      expect(release.statusCode).toBe(200);
      expect(release.json()).toMatchObject({ ok: true, result: { released: true } });
      expect(handleExecutionRunConnectedServiceRelease).toHaveBeenCalledWith(expect.objectContaining(RELEASE_PAYLOAD));
    } finally {
      await app.close();
    }
  });
});
