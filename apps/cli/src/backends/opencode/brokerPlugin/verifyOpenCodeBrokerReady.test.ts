import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '@/backends/opencode/server/openCodeManagedServerEnv';

import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  serializeOpenCodeBrokerSelections,
} from './openCodeBrokerPluginEnv';
import { ensureOpenCodeBrokerPluginAssets, resolveOpenCodeBrokerPluginPath } from './openCodeBrokerPluginAssets';
import { verifyOpenCodeBrokerReadyForConnectedSession } from './verifyOpenCodeBrokerReady';

async function writeDaemonState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-ready-daemon-'));
  const file = join(dir, 'daemon.state.json');
  await writeFile(file, JSON.stringify({ httpPort: 1234, controlToken: 'tok' }), 'utf8');
  return file;
}

describe('verifyOpenCodeBrokerReadyForConnectedSession (fail-closed preflight)', () => {
  it('is a no-op for native sessions (no selection identity)', async () => {
    expect(await verifyOpenCodeBrokerReadyForConnectedSession({} as NodeJS.ProcessEnv)).toEqual({ ready: true });
  });

  it('is ready for a connected direct-API-key session (no brokered provider)', async () => {
    const env = { [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|x' } as NodeJS.ProcessEnv;
    expect(await verifyOpenCodeBrokerReadyForConnectedSession(env)).toEqual({ ready: true });
  });

  it('fails closed when the brokered plugin file is missing (not written to the auto-load dir)', async () => {
    // Readiness depends on the plugin FILE existing in the config-home auto-load dir, NOT on any
    // OPENCODE_CONFIG_CONTENT.plugin registration (which OpenCode does not honor for an absolute path).
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-ready-'));
    const env = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:p:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null } }),
      [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonState(),
      [OPEN_CODE_BROKER_LOAD_NONCE_ENV]: 'spawn-missing-file',
    } as NodeJS.ProcessEnv;
    const result = await verifyOpenCodeBrokerReadyForConnectedSession(env, { happyHomeDir: home });
    expect(result).toEqual({ ready: false, reason: 'broker_plugin_file_missing:openai' });
  });

  it('is ready when the plugin .js file exists, the bridge is reachable, AND the load handshake was observed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-ready-'));
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], happyHomeDir: home });
    // The plugin is a `.js` file in the connected config home's opencode/plugin/ auto-load dir.
    expect(resolveOpenCodeBrokerPluginPath('openai', home).endsWith('.js')).toBe(true);
    const env = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:p:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null } }),
      [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonState(),
      [OPEN_CODE_BROKER_LOAD_NONCE_ENV]: 'spawn-ready',
    } as NodeJS.ProcessEnv;
    expect(await verifyOpenCodeBrokerReadyForConnectedSession(env, {
      happyHomeDir: home,
      verifyLoadHandshake: async (selectionIdentity, loadNonce) =>
        selectionIdentity === 'opencode|connected|openai-codex:p:' && loadNonce === 'spawn-ready',
    })).toEqual({ ready: true });
  });

  it('fails closed when the broker plugin never reported its load handshake within the bounded wait (F4)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-ready-'));
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], happyHomeDir: home });
    const env = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:p:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null } }),
      [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonState(),
      [OPEN_CODE_BROKER_LOAD_NONCE_ENV]: 'spawn-not-loaded',
    } as NodeJS.ProcessEnv;
    const result = await verifyOpenCodeBrokerReadyForConnectedSession(env, {
      happyHomeDir: home,
      verifyLoadHandshake: async () => false,
    });
    expect(result).toEqual({ ready: false, reason: 'broker_plugin_not_loaded' });
  });

  it('fails closed when the daemon bridge state is unreachable (before any handshake check)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-broker-ready-'));
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], happyHomeDir: home });
    const env = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:p:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null } }),
      [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: '/nonexistent/daemon.state.json',
      [OPEN_CODE_BROKER_LOAD_NONCE_ENV]: 'spawn-unreachable',
    } as NodeJS.ProcessEnv;
    expect(await verifyOpenCodeBrokerReadyForConnectedSession(env, {
      happyHomeDir: home,
      verifyLoadHandshake: async () => true,
    })).toEqual({ ready: false, reason: 'broker_daemon_bridge_unreachable' });
  });
});
