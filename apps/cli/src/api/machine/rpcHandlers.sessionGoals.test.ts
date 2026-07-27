import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionUsageLimitRecoveryOperationResultV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineSessionGoalRpcHandlers } from './rpcHandlers.sessionGoals';
import type { Credentials } from '@/persistence';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

function parseUsageLimitResult(value: unknown) {
  return SessionUsageLimitRecoveryOperationResultV1Schema.parse(value);
}

describe('rpcHandlers.sessionGoals', () => {
  const credentials: Credentials = {
    token: 'token-1',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };

  let handlers: Map<string, (raw: unknown) => Promise<unknown>>;
  let sessionGoalSet: ReturnType<typeof vi.fn>;
  let sessionGoalClear: ReturnType<typeof vi.fn>;
  let sessionGoalGet: ReturnType<typeof vi.fn>;
  let sessionVendorPluginCatalogList: ReturnType<typeof vi.fn>;
  let sessionSkillCatalogList: ReturnType<typeof vi.fn>;
  let sessionUsageLimitWaitResumeEnable: ReturnType<typeof vi.fn>;
  let sessionUsageLimitWaitResumeCancel: ReturnType<typeof vi.fn>;
  let sessionUsageLimitCheckNow: ReturnType<typeof vi.fn>;
  let sessionUsageLimitSwitchAccountNow: ReturnType<typeof vi.fn>;
  let sessionUsageLimitConsumeResetCredit: ReturnType<typeof vi.fn>;
  let createCliActionDepsParams: unknown[];

  beforeEach(() => {
    handlers = new Map();
    sessionGoalSet = vi.fn(async () => ({ ok: true }));
    sessionGoalClear = vi.fn(async () => ({ ok: true }));
    sessionGoalGet = vi.fn(async () => ({ workState: null }));
    sessionVendorPluginCatalogList = vi.fn(async () => ({ vendorPlugins: [] }));
    sessionSkillCatalogList = vi.fn(async () => ({ skills: [] }));
    sessionUsageLimitWaitResumeEnable = vi.fn(async () => ({
      ok: true,
      status: 'waiting',
      sessionId: 'resolved-session',
    }));
    sessionUsageLimitWaitResumeCancel = vi.fn(async () => ({
      ok: true,
      status: 'cancelled',
      sessionId: 'resolved-session',
    }));
    sessionUsageLimitCheckNow = vi.fn(async () => ({
      ok: true,
      status: 'waiting',
      sessionId: 'resolved-session',
    }));
    sessionUsageLimitSwitchAccountNow = vi.fn(async () => ({
      ok: true,
      status: 'switch_applied',
      sessionId: 'resolved-session',
    }));
    sessionUsageLimitConsumeResetCredit = vi.fn(async () => ({
      ok: true,
      status: 'ready',
      sessionId: 'resolved-session',
    }));
    createCliActionDepsParams = [];
  });

  function registerWithTransport(options: Readonly<{
    resumeInactiveSessionWhenUsageLimitReady?: (input: unknown) => Promise<boolean> | boolean;
    scheduleInactiveSessionUsageLimitRecoveryCheck?: (input: unknown) => void;
    cancelInactiveSessionUsageLimitRecoveryCheck?: (input: unknown) => void;
    notifyConnectedServiceRuntimeAuthFailure?: (input: unknown) => Promise<unknown>;
  }> = {}) {
    const rawSession = createSessionRecordFixture({
      id: 'resolved-session',
      metadata: '{}',
      path: '/repo',
      host: 'localhost',
      machineId: 'machine-1',
      encryptionMode: 'plain',
    });
    registerMachineSessionGoalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      deps: {
        readCredentials: async () => credentials,
        resolveSessionTransportContext: async () => ({
          ok: true,
          sessionId: 'resolved-session',
          rawSession,
          ctx: {
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
          },
          mode: 'plain',
        }),
        ...(options.resumeInactiveSessionWhenUsageLimitReady
          ? { resumeInactiveSessionWhenUsageLimitReady: options.resumeInactiveSessionWhenUsageLimitReady }
          : {}),
        ...(options.scheduleInactiveSessionUsageLimitRecoveryCheck
          ? { scheduleInactiveSessionUsageLimitRecoveryCheck: options.scheduleInactiveSessionUsageLimitRecoveryCheck }
          : {}),
        ...(options.cancelInactiveSessionUsageLimitRecoveryCheck
          ? { cancelInactiveSessionUsageLimitRecoveryCheck: options.cancelInactiveSessionUsageLimitRecoveryCheck }
          : {}),
        ...(options.notifyConnectedServiceRuntimeAuthFailure
          ? { notifyConnectedServiceRuntimeAuthFailure: options.notifyConnectedServiceRuntimeAuthFailure }
          : {}),
        createCliActionDeps: (params) => {
          createCliActionDepsParams.push(params);
          return {
            sessionGoalSet,
            sessionGoalClear,
            sessionGoalGet,
            sessionVendorPluginCatalogList,
            sessionSkillCatalogList,
            sessionUsageLimitWaitResumeEnable,
            sessionUsageLimitWaitResumeCancel,
            sessionUsageLimitCheckNow,
            sessionUsageLimitSwitchAccountNow,
            sessionUsageLimitConsumeResetCredit,
          };
        },
      },
    });
  }

  it('routes inactive-session goal set controls through CLI action deps', async () => {
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET)?.({
      sessionId: 'session-prefix',
      status: 'paused',
    });

    expect(result).toEqual({ ok: true });
    expect(sessionGoalSet).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      status: 'paused',
    });
  });

  it('routes inactive-session goal clear controls through CLI action deps', async () => {
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR)?.({
      sessionId: 'session-prefix',
    });

    expect(result).toEqual({ ok: true });
    expect(sessionGoalClear).toHaveBeenCalledWith({ sessionId: 'resolved-session' });
  });

  it('routes inactive-session goal get controls through CLI action deps', async () => {
    sessionGoalGet.mockResolvedValueOnce({ workState: { v: 1, items: [] } });
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_GET)?.({
      sessionId: 'session-prefix',
    });

    expect(result).toEqual({ workState: { v: 1, items: [] } });
    expect(sessionGoalGet).toHaveBeenCalledWith({ sessionId: 'resolved-session' });
  });

  it('returns stable invalid-parameter errors before dispatching malformed controls', async () => {
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET)?.({
      sessionId: 'session-prefix',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionGoalSet).not.toHaveBeenCalled();

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      issueFingerprint: '   ',
    }))).toEqual({
      ok: false,
      status: 'malformed_response',
      sessionId: 'session-prefix',
      errorCode: 'invalid_parameters',
    });
    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'session-prefix',
      issueFingerprint: '   ',
    }))).toEqual({
      ok: false,
      status: 'malformed_response',
      sessionId: 'session-prefix',
      errorCode: 'invalid_parameters',
    });
    expect(sessionUsageLimitWaitResumeEnable).not.toHaveBeenCalled();
    expect(sessionUsageLimitWaitResumeCancel).not.toHaveBeenCalled();
  });

  it('rejects non-boolean rememberPreference values before dispatching usage-limit enable controls', async () => {
    registerWithTransport();

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      rememberPreference: 'yes',
    }))).toEqual({
      ok: false,
      status: 'malformed_response',
      sessionId: 'session-prefix',
      errorCode: 'invalid_parameters',
    });

    expect(sessionUsageLimitWaitResumeEnable).not.toHaveBeenCalled();
  });

  it('routes inactive-session catalog list controls through CLI action deps', async () => {
    sessionVendorPluginCatalogList.mockResolvedValueOnce({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    });
    sessionSkillCatalogList.mockResolvedValueOnce({
      skills: [{ name: 'review', origin: 'codex_native' }],
    });
    registerWithTransport();

    await expect(handlers.get('daemon.sessionVendorPluginCatalog.list')?.({
      sessionId: 'session-prefix',
      cwd: '/repo',
    })).resolves.toEqual({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    });
    await expect(handlers.get('daemon.sessionSkillCatalog.list')?.({
      sessionId: 'session-prefix',
      cwd: '/repo',
    })).resolves.toEqual({
      skills: [{ name: 'review', origin: 'codex_native' }],
    });

    expect(sessionVendorPluginCatalogList).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      cwd: '/repo',
    });
    expect(sessionSkillCatalogList).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      cwd: '/repo',
    });
  });

  it('routes inactive-session usage-limit recovery controls through CLI action deps', async () => {
    registerWithTransport();

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      rememberPreference: true,
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'resolved-session',
    });
    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'session-prefix',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      armedAtMs: 123,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    }))).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'resolved-session',
    });
    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'resolved-session',
    });
    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
      provider: ' codex ',
      operation: 'switch_account_now',
    }))).toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'resolved-session',
    });
    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
      provider: ' codex ',
      operation: 'consume_reset_credit',
      resumePromptMode: 'off',
    }))).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'resolved-session',
    });
    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
      operation: 'consume_the_moon',
    }))).toEqual({
      ok: false,
      status: 'malformed_response',
      sessionId: 'session-prefix',
      errorCode: 'invalid_parameters',
    });

    expect(sessionUsageLimitWaitResumeEnable).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      remember: true,
    });
    expect(sessionUsageLimitWaitResumeCancel).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      armedAtMs: 123,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    });
    expect(sessionUsageLimitCheckNow).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
    });
    expect(sessionUsageLimitSwitchAccountNow).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      provider: 'codex',
    });
    expect(sessionUsageLimitConsumeResetCredit).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      provider: 'codex',
      resumePromptMode: 'off',
    });
  });

  it('passes the daemon usage-limit resume callback into CLI action deps', async () => {
    const resumeInactiveSessionWhenUsageLimitReady = vi.fn(async () => true);
    registerWithTransport({ resumeInactiveSessionWhenUsageLimitReady });

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
    }))).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'resolved-session',
    });

    expect(createCliActionDepsParams.at(-1)).toMatchObject({
      resumeInactiveSessionWhenUsageLimitReady,
    });
  });

  it('passes daemon usage-limit scheduling callbacks into CLI action deps', async () => {
    const scheduleInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    const cancelInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    registerWithTransport({
      scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck,
    });

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      issueFingerprint: 'usage-limit:session-prefix:reset',
    }))).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'resolved-session',
    });

    expect(createCliActionDepsParams.at(-1)).toMatchObject({
      scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck,
    });
  });

  it('passes the daemon runtime-auth notifier into CLI action deps for switch-account controls', async () => {
    const notifyConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched' } },
    }));
    registerWithTransport({ notifyConnectedServiceRuntimeAuthFailure });

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
      provider: 'codex',
      operation: 'switch_account_now',
    }))).toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'resolved-session',
    });

    expect(createCliActionDepsParams.at(-1)).toMatchObject({
      notifyConnectedServiceRuntimeAuthFailure,
    });
  });

  it('forwards feature-disabled usage-limit results as schema-valid machine RPC responses', async () => {
    sessionUsageLimitCheckNow.mockResolvedValueOnce({
      ok: false,
      status: 'unsupported',
      sessionId: 'resolved-session',
      errorCode: 'feature_disabled',
    });
    registerWithTransport();

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'resolved-session',
      errorCode: 'feature_disabled',
    });
  });

  it('returns schema-valid usage-limit errors when credentials are unavailable', async () => {
    registerMachineSessionGoalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      deps: {
        readCredentials: async () => null,
      },
    });

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'session-prefix',
      errorCode: 'not_authenticated',
    });
  });

  it('returns schema-valid usage-limit errors when machine RPC session resolution fails', async () => {
    registerMachineSessionGoalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      deps: {
        readCredentials: async () => credentials,
        resolveSessionTransportContext: async () => ({
          ok: false,
          code: 'session_not_found',
          candidates: ['sess_a', 'sess_b'],
        }),
      },
    });

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'missing',
    }))).toEqual({
      ok: false,
      status: 'not_found',
      sessionId: 'missing',
      errorCode: 'session_not_found',
    });
  });

  it('returns schema-valid usage-limit errors when an action dependency is missing', async () => {
    registerMachineSessionGoalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      deps: {
        readCredentials: async () => credentials,
        resolveSessionTransportContext: async () => ({
          ok: true,
          sessionId: 'resolved-session',
          rawSession: createSessionRecordFixture({
            id: 'resolved-session',
            metadata: '{}',
            path: '/repo',
            host: 'localhost',
            machineId: 'machine-1',
            encryptionMode: 'plain',
          }),
          ctx: {
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
          },
          mode: 'plain',
        }),
        createCliActionDeps: () => ({
          sessionGoalSet,
          sessionGoalClear,
          sessionGoalGet,
          sessionVendorPluginCatalogList,
          sessionSkillCatalogList,
        }),
      },
    });

    expect(parseUsageLimitResult(await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'resolved-session',
      errorCode: 'action_not_supported',
    });
  });

  it('returns a parseable encrypted machine RPC result for switch-account controls', async () => {
    const encryptionKey = new Uint8Array(32).fill(11);
    const notifyConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
      },
    }));
    const rawSession = createSessionRecordFixture({
      id: 'resolved-session',
      metadata: '{}',
      path: '/repo',
      host: 'localhost',
      machineId: 'machine-1',
      encryptionMode: 'plain',
    });
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    registerMachineSessionGoalRpcHandlers({
      rpcHandlerManager,
      deps: {
        readCredentials: async () => credentials,
        resolveSessionTransportContext: async () => ({
          ok: true,
          sessionId: 'resolved-session',
          rawSession,
          ctx: {
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
          },
          mode: 'plain',
        }),
        notifyConnectedServiceRuntimeAuthFailure,
        createCliActionDeps: (params) => {
          createCliActionDepsParams.push(params);
          return {
            sessionGoalSet,
            sessionGoalClear,
            sessionGoalGet,
            sessionVendorPluginCatalogList,
            sessionSkillCatalogList,
            sessionUsageLimitWaitResumeEnable,
            sessionUsageLimitWaitResumeCancel,
            sessionUsageLimitCheckNow,
            sessionUsageLimitSwitchAccountNow,
          };
        },
      },
    });

    const encryptedResponse = await rpcHandlerManager.handleRequest({
      method: `${rawSession.machineId}:${RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW}`,
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', {
        sessionId: 'session-prefix',
        provider: 'codex',
        operation: 'switch_account_now',
      })),
    });

    expect(typeof encryptedResponse).toBe('string');
    expect(parseUsageLimitResult(decrypt(encryptionKey, 'dataKey', decodeBase64(encryptedResponse as string)))).toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'resolved-session',
    });
    expect(sessionUsageLimitSwitchAccountNow).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      provider: 'codex',
    });
    expect(createCliActionDepsParams.at(-1)).toMatchObject({
      notifyConnectedServiceRuntimeAuthFailure,
    });
  });
});
