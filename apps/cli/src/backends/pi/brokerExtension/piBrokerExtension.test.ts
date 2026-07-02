import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL,
  CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV,
  deriveConnectedServiceBrokerRefreshToken,
} from '@/daemon/connectedServices/broker/brokerRefreshCapabilityToken';

import {
  PI_BROKER_REFRESH_SCOPE_LABEL,
  PI_BROKER_REFRESH_TOKEN_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  applyPiBrokerRefreshTokenEnv,
  buildPiBrokerMarker,
  derivePiBrokerRefreshToken,
  ensurePiBrokerExtensionAsset,
  isPiBrokerMarker,
  parsePiBrokerSelections,
  resolvePiBrokerExtensionPath,
  serializePiBrokerSelections,
  verifyPiBrokerReadyForConnectedSession,
} from './index';

describe('piBrokerCapabilityToken (shared alias)', () => {
  it('is a thin alias over the SHARED provider-agnostic core (same token authorizes OpenCode + Pi)', () => {
    expect(PI_BROKER_REFRESH_SCOPE_LABEL).toBe(CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL);
    expect(PI_BROKER_REFRESH_TOKEN_ENV).toBe(CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV);
    expect(derivePiBrokerRefreshToken('master')).toBe(deriveConnectedServiceBrokerRefreshToken('master'));
  });
});

describe('piBrokerExtensionEnv markers + selections', () => {
  it('builds + recognises a versioned broker marker (never a real refresh token)', () => {
    const marker = buildPiBrokerMarker('anthropic', '1');
    expect(marker).toBe('happier-pi-broker:anthropic:1');
    expect(isPiBrokerMarker(marker)).toBe(true);
    expect(isPiBrokerMarker('sk-ant-ort-real')).toBe(false);
  });

  it('round-trips selections and rejects malformed/service-mismatched entries', () => {
    const serialized = serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: 'a', planType: null },
      openai: { serviceId: 'openai-codex', profileId: 'x', accountId: null, planType: 'pro' },
    });
    const parsed = parsePiBrokerSelections(serialized);
    expect(parsed.anthropic).toMatchObject({ serviceId: 'claude-subscription', profileId: 'c' });
    expect(parsed.openai).toMatchObject({ serviceId: 'openai-codex', profileId: 'x', planType: 'pro' });
    // Wrong service id for the provider slot ⇒ dropped.
    expect(parsePiBrokerSelections(JSON.stringify({ anthropic: { serviceId: 'openai-codex', profileId: 'c' } })).anthropic).toBeUndefined();
    expect(parsePiBrokerSelections('not json')).toEqual({});
  });
});

describe('applyPiBrokerRefreshTokenEnv (scoped-token injection, least privilege)', () => {
  it('injects ONLY the derived scoped token for brokered sessions; master never appears', () => {
    const env: Record<string, string> = {
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: null, planType: null },
      }),
    };
    applyPiBrokerRefreshTokenEnv(env, () => 'MASTER-CONTROL-TOKEN');
    expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).toBe(derivePiBrokerRefreshToken('MASTER-CONTROL-TOKEN'));
    expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).not.toBe('MASTER-CONTROL-TOKEN');
    for (const value of Object.values(env)) expect(value).not.toBe('MASTER-CONTROL-TOKEN');
  });

  it('is a strict no-op for native sessions (no selection identity)', () => {
    const env: Record<string, string> = {};
    applyPiBrokerRefreshTokenEnv(env, () => 'MASTER');
    expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).toBeUndefined();
  });

  it('is a strict no-op for direct-API-key sessions (selection identity but no brokered provider)', () => {
    const env: Record<string, string> = { [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected' };
    applyPiBrokerRefreshTokenEnv(env, () => 'MASTER');
    expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).toBeUndefined();
  });

  it('fails closed when the master control token is unavailable (does not inject)', () => {
    const env: Record<string, string> = {
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: null, planType: null },
      }),
    };
    applyPiBrokerRefreshTokenEnv(env, () => null);
    expect(env[PI_BROKER_REFRESH_TOKEN_ENV]).toBeUndefined();
  });
});

describe('verifyPiBrokerReadyForConnectedSession (fail-closed preflight)', () => {
  let agentDir: string;
  let daemonStatePath: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-broker-verify-'));
    agentDir = join(root, 'pi-agent-dir');
    daemonStatePath = join(root, 'daemon.state.json');
    await writeFile(daemonStatePath, JSON.stringify({ httpPort: 5, controlToken: 'tok' }), 'utf8');
  });
  afterEach(() => {
    // no shared global state
  });

  const brokeredEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
    PI_CODING_AGENT_DIR: agentDir,
    [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
    [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: null, planType: null },
    }),
    [PI_BROKER_LOAD_NONCE_ENV]: 'pi-spawn-ready',
    HAPPIER_PI_BROKER_DAEMON_STATE_PATH: daemonStatePath,
    ...overrides,
  });

  it('is ready when the extension file exists, the bridge is reachable, and the handshake is observed', async () => {
    await ensurePiBrokerExtensionAsset(agentDir);
    const readiness = await verifyPiBrokerReadyForConnectedSession(brokeredEnv(), {
      verifyLoadHandshake: async (selectionIdentity, loadNonce) =>
        selectionIdentity === 'pi|connected|broker:1|anthropic:c:' && loadNonce === 'pi-spawn-ready',
    });
    expect(readiness).toEqual({ ready: true });
  });

  it('is a strict no-op (ready) for native sessions (no selection identity)', async () => {
    const readiness = await verifyPiBrokerReadyForConnectedSession({ PI_CODING_AGENT_DIR: agentDir });
    expect(readiness).toEqual({ ready: true });
  });

  it('fails closed when the extension file is missing', async () => {
    const readiness = await verifyPiBrokerReadyForConnectedSession(brokeredEnv(), {
      verifyLoadHandshake: async () => true,
    });
    expect(readiness).toEqual({ ready: false, reason: 'broker_extension_file_missing' });
  });

  it('fails closed when the daemon bridge is unreachable', async () => {
    await ensurePiBrokerExtensionAsset(agentDir);
    const readiness = await verifyPiBrokerReadyForConnectedSession(
      brokeredEnv({ HAPPIER_PI_BROKER_DAEMON_STATE_PATH: join(agentDir, 'missing.json') }),
      { verifyLoadHandshake: async () => true },
    );
    expect(readiness).toEqual({ ready: false, reason: 'broker_daemon_bridge_unreachable' });
  });

  it('fails closed with broker_extension_not_loaded when the handshake never arrives', async () => {
    await ensurePiBrokerExtensionAsset(agentDir);
    const readiness = await verifyPiBrokerReadyForConnectedSession(brokeredEnv(), {
      handshakeWaitMs: 0,
      verifyLoadHandshake: async () => false,
    });
    expect(readiness).toEqual({ ready: false, reason: 'broker_extension_not_loaded' });
  });
});

describe('ensurePiBrokerExtensionAsset (idempotent write)', () => {
  it('writes the extension into <agentDir>/extensions/ and is write-if-changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-broker-asset-'));
    const agentDir = join(root, 'pi-agent-dir');
    await mkdir(agentDir, { recursive: true });
    const path = await ensurePiBrokerExtensionAsset(agentDir);
    expect(path).toBe(resolvePiBrokerExtensionPath(agentDir));
    const content = await readFile(path, 'utf8');
    expect(content).toContain('HappierPiAuthBrokerExtension');
    expect(content).toContain('registerProvider');
    // Idempotent: a second call does not change the bytes.
    const path2 = await ensurePiBrokerExtensionAsset(agentDir);
    expect(await readFile(path2, 'utf8')).toBe(content);
  });
});
