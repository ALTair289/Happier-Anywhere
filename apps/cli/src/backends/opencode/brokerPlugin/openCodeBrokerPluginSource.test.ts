import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_REFRESH_TOKEN_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  buildOpenCodeBrokerMarker,
  buildOpenCodeBrokerPluginSource,
  deriveOpenCodeBrokerRefreshToken,
  serializeOpenCodeBrokerSelections,
} from './index';

const REFRESH_TOKEN_SENTINEL = 'refresh-token-MUST-NOT-LEAK';
const MASTER_CONTROL_TOKEN_SENTINEL = 'master-control-token-MUST-NOT-LEAK';

type BrokerHooks = {
  loader: (getAuth: () => Promise<unknown>) => Promise<Record<string, unknown>>;
  provider: string;
  raw: Record<string, unknown>;
};

async function loadBrokerPlugin(provider: 'openai' | 'anthropic'): Promise<BrokerHooks> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-plugin-'));
  const file = join(dir, `broker-${provider}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, buildOpenCodeBrokerPluginSource(provider), 'utf8');
  const mod = await import(pathToFileURL(file).href);
  const factory = mod.default as () => Promise<{ auth: { provider: string; loader: BrokerHooks['loader'] } }>;
  const hooks = await factory();
  return { loader: hooks.auth.loader, provider: hooks.auth.provider, raw: hooks as unknown as Record<string, unknown> };
}

async function writeDaemonStateFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-daemon-'));
  const file = join(dir, 'daemon.state.json');
  await writeFile(file, JSON.stringify({ httpPort: 51999, controlToken: token }), 'utf8');
  return file;
}

/** Inject the SCOPED broker-refresh token (NOT the master control token) into the broker's env. */
function setScopedTokenFromMaster(masterControlToken: string): void {
  process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV] = deriveOpenCodeBrokerRefreshToken(masterControlToken);
}

describe('openCodeBrokerPluginSource (generated artifact, exercised live)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env[OPEN_CODE_BROKER_SELECTIONS_ENV];
    delete process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV];
    delete process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV];
    delete process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env[OPEN_CODE_BROKER_SELECTIONS_ENV];
    delete process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV];
    delete process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV];
    delete process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE;
  });

  it('engages only on the Happier broker marker, not on a real direct credential', async () => {
    const { loader, provider } = await loadBrokerPlugin('openai');
    expect(provider).toBe('openai');

    const directKey = await loader(async () => ({ type: 'api', key: 'sk-real-openai-key' }));
    expect(directKey).toEqual({});

    const marker = buildOpenCodeBrokerMarker('openai', '1');
    const brokered = await loader(async () => ({ type: 'api', key: marker }));
    expect(typeof brokered.fetch).toBe('function');
    expect(brokered.apiKey).toBe(marker);
  });

  it('Codex: fetches the access token from the daemon bridge and shapes the request (no refresh token anywhere)', async () => {
    // The daemon-state file holds the MASTER control token, but the broker must NOT read it for auth:
    // it sends the SCOPED broker-refresh token from its env (least privilege, plan §5 item 3).
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    setScopedTokenFromMaster(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'codex-pro', accountId: null, planType: 'pro' },
    });

    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      if (url.includes('/chatgpt-auth-tokens/refresh')) {
        return new Response(
          JSON.stringify({ ok: true, result: { accessToken: 'fresh-access-token', chatgptAccountId: 'acct_99', chatgptPlanType: 'pro' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const { loader } = await loadBrokerPlugin('openai');
    const result = await loader(async () => ({ type: 'api', key: buildOpenCodeBrokerMarker('openai', '1') }));
    // The loader pins the Codex backend base URL so the AI SDK builds <baseURL>/responses.
    expect(result.baseURL).toBe('https://chatgpt.com/backend-api');
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;

    await brokeredFetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      headers: { 'x-api-key': REFRESH_TOKEN_SENTINEL, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-codex', input: [] }),
    });

    const bridgeCall = calls.find((c) => c.url.includes('/chatgpt-auth-tokens/refresh'));
    expect(bridgeCall).toBeDefined();
    expect(bridgeCall!.url).toBe('http://127.0.0.1:51999/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh');
    // The scoped token (NOT the master) is sent; the master must never appear on the wire.
    expect(bridgeCall!.headers.get('x-happier-daemon-token')).toBe(deriveOpenCodeBrokerRefreshToken(MASTER_CONTROL_TOKEN_SENTINEL));
    expect(bridgeCall!.headers.get('x-happier-daemon-token')).not.toBe(MASTER_CONTROL_TOKEN_SENTINEL);
    expect(JSON.parse(bridgeCall!.body)).toMatchObject({ selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'codex-pro' } });

    const providerCall = calls.find((c) => c.url.includes('chatgpt.com/backend-api'));
    expect(providerCall).toBeDefined();
    expect(providerCall!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(providerCall!.headers.get('authorization')).toBe('Bearer fresh-access-token');
    expect(providerCall!.headers.get('chatgpt-account-id')).toBe('acct_99');
    expect(providerCall!.headers.get('openai-beta')).toBe('responses=experimental');
    expect(providerCall!.headers.get('originator')).toBe('codex_cli_rs');
    expect(providerCall!.headers.get('x-api-key')).toBeNull();
    const providerBody = JSON.parse(providerCall!.body);
    expect(providerBody.model).toBe('gpt-5.1-codex');
    expect(providerBody.include).toContain('reasoning.encrypted_content');

    // No-leak: nothing the broker ever transmits contains the refresh-token OR the master control token.
    for (const call of calls) {
      expect(call.body).not.toContain(REFRESH_TOKEN_SENTINEL);
      expect(call.body).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      for (const [, value] of call.headers.entries()) {
        expect(value).not.toContain(REFRESH_TOKEN_SENTINEL);
        expect(value).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      }
    }
  });

  it('Codex: on a 401 it forces one bridge refresh (forceRefresh flag) and retries; the first call does NOT force', async () => {
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    setScopedTokenFromMaster('tok');
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'p', accountId: 'a', planType: null },
    });
    let bridgeCalls = 0;
    let providerCalls = 0;
    const bridgeBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      if (url.includes('/chatgpt-auth-tokens/refresh')) {
        bridgeCalls += 1;
        bridgeBodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
        return new Response(JSON.stringify({ ok: true, result: { accessToken: `access-${bridgeCalls}`, chatgptAccountId: 'a' } }), { status: 200 });
      }
      providerCalls += 1;
      return new Response('x', { status: providerCalls === 1 ? 401 : 200 });
    }) as unknown as typeof fetch;

    const { loader } = await loadBrokerPlugin('openai');
    const result = await loader(async () => ({ type: 'api', key: buildOpenCodeBrokerMarker('openai', '1') }));
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;
    const response = await brokeredFetch('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    expect(bridgeCalls).toBe(2);
    expect(providerCalls).toBe(2);
    // F6: the cold fetch does NOT force a rotation; only the 401-retry path forces.
    expect(bridgeBodies[0]).toMatchObject({ forceRefresh: false });
    expect(bridgeBodies[1]).toMatchObject({ forceRefresh: true });
  });

  it('pings the daemon load-handshake endpoint with the scoped token on plugin activation (F4)', async () => {
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    setScopedTokenFromMaster(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'codex-pro', accountId: null, planType: 'pro' },
    });
    process.env.HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY = 'opencode|connected|broker:1|openai-codex:codex-pro:';
    process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE = 'opencode-spawn-1';
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      return new Response(JSON.stringify({ ok: true, result: { acknowledged: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      // Activating the plugin (calling the factory) must register the load handshake with the daemon.
      await loadBrokerPlugin('openai');
      // The handshake is best-effort + bounded; let the microtask/0ms timer flush.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const handshake = calls.find((c) => c.url.includes('/connected-service-auth/broker/loaded'));
      expect(handshake).toBeDefined();
      expect(handshake!.url).toBe('http://127.0.0.1:51999/connected-service-auth/broker/loaded');
      expect(handshake!.headers.get('x-happier-daemon-token')).toBe(deriveOpenCodeBrokerRefreshToken(MASTER_CONTROL_TOKEN_SENTINEL));
      const body = JSON.parse(handshake!.body);
      expect(body.selectionIdentity).toBe('opencode|connected|broker:1|openai-codex:codex-pro:');
      expect(body.loadNonce).toBe('opencode-spawn-1');
      expect(body.providers).toContain('openai');
      // No-leak: the handshake never carries the MASTER control token (header or body).
      expect(handshake!.headers.get('x-happier-daemon-token')).not.toBe(MASTER_CONTROL_TOKEN_SENTINEL);
      expect(handshake!.body).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
    } finally {
      delete process.env.HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY;
      delete process.env.HAPPIER_OPENCODE_BROKER_LOAD_NONCE;
    }
  });

  it('Anthropic: uses Bearer + anthropic-beta, deletes x-api-key, and injects the Claude Code system identity', async () => {
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    setScopedTokenFromMaster('tok');
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
    });
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      if (url.includes('/anthropic-auth-tokens/refresh')) {
        return new Response(JSON.stringify({ ok: true, result: { accessToken: 'claude-access', expiresAt: Date.now() + 3_600_000 } }), { status: 200 });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const { loader, provider } = await loadBrokerPlugin('anthropic');
    expect(provider).toBe('anthropic');
    const result = await loader(async () => ({ type: 'api', key: buildOpenCodeBrokerMarker('anthropic', '1') }));
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;

    await brokeredFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': REFRESH_TOKEN_SENTINEL },
      body: JSON.stringify({ model: 'claude-x', system: 'Be helpful', messages: [] }),
    });

    const providerCall = calls.find((c) => c.url.includes('api.anthropic.com'));
    expect(providerCall).toBeDefined();
    expect(providerCall!.headers.get('authorization')).toBe('Bearer claude-access');
    expect(providerCall!.headers.get('anthropic-beta')).toContain('oauth-2025-04-20');
    expect(providerCall!.headers.get('x-api-key')).toBeNull();
    const body = JSON.parse(providerCall!.body);
    const firstSystem = Array.isArray(body.system) ? body.system[0] : body.system;
    expect(firstSystem.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    for (const call of calls) expect(call.body).not.toContain(REFRESH_TOKEN_SENTINEL);
  });
});
