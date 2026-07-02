import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBrokerBridgeCallSource } from './brokerBridgeCallSource';

/**
 * The shared bridge-call source is provider-agnostic JS embedded by BOTH the OpenCode plugin and the
 * Pi extension. We exercise it live by wrapping it in a tiny ESM module that exports the generated
 * `fetchAccessTokenFromBridge` so the same code path both runtimes embed is tested once, here.
 */
const SELECTIONS_ENV = 'TEST_BROKER_SELECTIONS';
const DAEMON_STATE_PATH_ENV = 'TEST_BROKER_DAEMON_STATE_PATH';
const REFRESH_TOKEN_ENV = 'TEST_BROKER_REFRESH_TOKEN';
const PLUGIN_VERSION_ENV = 'TEST_BROKER_VERSION';

type BridgeFixture = Readonly<{
  providerTag: string;
  bridgePath: string;
  serviceId: string;
  planTypeBodyField?: string;
  accountIdResultFields?: readonly string[];
}>;

async function loadBridgeCaller(fixture: BridgeFixture): Promise<
  (forceRefresh: boolean) => Promise<{ accessToken: string; accountId: string | null; expiresAt: number | null }>
> {
  const source = buildBrokerBridgeCallSource({
    ...fixture,
    selectionsEnv: SELECTIONS_ENV,
    daemonStatePathEnv: DAEMON_STATE_PATH_ENV,
    refreshTokenEnv: REFRESH_TOKEN_ENV,
    pluginVersionEnv: PLUGIN_VERSION_ENV,
    pluginVersion: '7',
    sessionTag: 'test-broker',
  });
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-bridge-'));
  const file = join(dir, `bridge-${fixture.providerTag}-${Math.random().toString(36).slice(2)}.mjs`);
  // Wrap the (statement) source so the embedded function becomes an ESM export we can call directly.
  // The shared source assumes the assembling module supplies `readFileSync` (its documented contract),
  // exactly as the OpenCode plugin + Pi extension preambles do; replicate that here.
  await writeFile(
    file,
    `import { readFileSync } from "node:fs";\n${source}\nexport { fetchAccessTokenFromBridge };\n`,
    'utf8',
  );
  const mod = await import(pathToFileURL(file).href);
  return mod.fetchAccessTokenFromBridge;
}

async function writeDaemonStateFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-bridge-daemon-'));
  const file = join(dir, 'daemon.state.json');
  await writeFile(file, JSON.stringify({ httpPort: 41999, controlToken: token }), 'utf8');
  return file;
}

describe('brokerBridgeCallSource (shared bridge-call, exercised live)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env[SELECTIONS_ENV];
    delete process.env[DAEMON_STATE_PATH_ENV];
    delete process.env[REFRESH_TOKEN_ENV];
    delete process.env[PLUGIN_VERSION_ENV];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env[SELECTIONS_ENV];
    delete process.env[DAEMON_STATE_PATH_ENV];
    delete process.env[REFRESH_TOKEN_ENV];
    delete process.env[PLUGIN_VERSION_ENV];
  });

  it('reads httpPort from daemon-state, sends the SCOPED token, POSTs caller-owned bridge metadata', async () => {
    process.env[DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('master-MUST-NOT-LEAK');
    process.env[REFRESH_TOKEN_ENV] = 'scoped-broker-token';
    const fixture = {
      providerTag: 'provider-a',
      bridgePath: '/connected-service-auth/service-a/access-token/refresh',
      serviceId: 'service-a',
      planTypeBodyField: 'planTypeHint',
      accountIdResultFields: ['providerAccountId'] as const,
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: { serviceId: fixture.serviceId, profileId: 'profile-a', accountId: null, planType: 'pro' },
    });
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url: String(input), headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      return new Response(
        JSON.stringify({ ok: true, result: { accessToken: 'fresh-access', providerAccountId: 'acct_7' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    const result = await fetchAccessTokenFromBridge(false);

    expect(result.accessToken).toBe('fresh-access');
    expect(result.accountId).toBe('acct_7');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://127.0.0.1:41999${fixture.bridgePath}`);
    expect(calls[0].headers.get('x-happier-daemon-token')).toBe('scoped-broker-token');
    expect(calls[0].headers.get('x-happier-daemon-token')).not.toBe('master-MUST-NOT-LEAK');
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({
      selection: { kind: 'profile', serviceId: fixture.serviceId, profileId: 'profile-a' },
      planTypeHint: 'pro',
      forceRefresh: false,
    });
    // The master control token must never appear on the wire.
    expect(calls[0].body).not.toContain('master-MUST-NOT-LEAK');
  });

  it('omits a plan hint unless the caller declares one and forwards forceRefresh', async () => {
    process.env[DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    process.env[REFRESH_TOKEN_ENV] = 'scoped';
    const fixture = {
      providerTag: 'provider-b',
      bridgePath: '/connected-service-auth/service-b/access-token/refresh',
      serviceId: 'service-b',
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: { serviceId: fixture.serviceId, profileId: 'profile-b', accountId: null, planType: null },
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
      expect(String(input)).toBe(`http://127.0.0.1:41999${fixture.bridgePath}`);
      return new Response(JSON.stringify({ ok: true, result: { accessToken: 'claude-access', expiresAt: 123456 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    const result = await fetchAccessTokenFromBridge(true);
    expect(result.accessToken).toBe('claude-access');
    expect(result.expiresAt).toBe(123456);
    expect(bodies[0]).toMatchObject({
      selection: { kind: 'profile', serviceId: fixture.serviceId, profileId: 'profile-b' },
      forceRefresh: true,
    });
    expect(bodies[0]).not.toHaveProperty('planTypeHint');
  });

  it('throws a clear error when the scoped token is missing (fail-closed)', async () => {
    process.env[DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    const fixture = {
      providerTag: 'provider-a',
      bridgePath: '/connected-service-auth/service-a/access-token/refresh',
      serviceId: 'service-a',
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: { serviceId: fixture.serviceId, profileId: 'p', accountId: null, planType: null },
    });
    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    await expect(fetchAccessTokenFromBridge(false)).rejects.toThrow(/scoped_token_missing/);
  });
});
