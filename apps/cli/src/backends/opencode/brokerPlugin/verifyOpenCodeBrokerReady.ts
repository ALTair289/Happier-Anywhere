import { readFile, access } from 'node:fs/promises';

import { configuration } from '@/configuration';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '@/backends/opencode/server/openCodeManagedServerEnv';

import {
  OPEN_CODE_BROKER_STATE_PATH_ENV,
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
  type OpenCodeBrokerProvider,
} from './openCodeBrokerPluginEnv';
import { resolveOpenCodeBrokerPluginPath } from './openCodeBrokerPluginAssets';

export type OpenCodeBrokerReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reason: string }>;

/** Bounded total wait for the broker's load handshake to arrive before failing closed (F4). */
const DEFAULT_HANDSHAKE_WAIT_MS = 4_000;
const HANDSHAKE_POLL_INTERVAL_MS = 200;

async function defaultVerifyLoadHandshake(selectionIdentity: string, loadNonce: string, deadlineMs: number): Promise<boolean> {
  // Lazy import to avoid pulling daemon control-client wiring into modules that only need readiness types.
  const { queryDaemonOpenCodeBrokerLoadHandshake } = await import('@/daemon/controlClient');
  // Poll until the daemon has seen the handshake or the bounded deadline elapses (best-effort, cheap).
  for (;;) {
    if (await queryDaemonOpenCodeBrokerLoadHandshake(selectionIdentity, loadNonce).catch(() => false)) return true;
    if (Date.now() >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_POLL_INTERVAL_MS));
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function brokerStateUsable(path: string | undefined): Promise<boolean> {
  if (typeof path !== 'string' || path.trim().length === 0) return false;
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.httpPort === 'number'
      && typeof parsed.connectedServiceBrokerRefreshToken === 'string'
      && parsed.connectedServiceBrokerRefreshToken.length > 0;
  } catch {
    return false;
  }
}

/**
 * Fail-closed preflight: verify the Happier broker is materialized + reachable for a connected
 * session before its first prompt. For NATIVE sessions (no selection identity) and direct-API-key
 * connected sessions (no brokered provider) it is a strict no-op (`ready: true`).
 *
 * For brokered sessions it confirms (a) each brokered provider's broker plugin `.js` file exists in
 * the connected config home's `opencode/plugin/` auto-load dir (OpenCode loads it from the redirected
 * `XDG_CONFIG_HOME`; live-verified that an absolute `OPENCODE_CONFIG_CONTENT.plugin` path or a `.mjs`
 * file does NOT load), and (b) the minimal broker-state target is readable with a scoped broker
 * capability. If any check fails the session MUST be failed with a clear materialization error — never silently fall back
 * to native/upstream auth (the marker is itself non-functional without the plugin, so request-time
 * failure is the backstop).
 */
export async function verifyOpenCodeBrokerReadyForConnectedSession(
  env: NodeJS.ProcessEnv,
  options?: Readonly<{
    happyHomeDir?: string;
    /** Bounded total wait for the load handshake (F4). Defaults to {@link DEFAULT_HANDSHAKE_WAIT_MS}. */
    handshakeWaitMs?: number;
    /**
     * Injectable load-handshake verifier (test seam). Defaults to a bounded poll of the daemon
     * control client. Receives the selection identity + an absolute deadline (epoch ms).
     */
    verifyLoadHandshake?: (selectionIdentity: string, loadNonce: string, deadlineMs: number) => Promise<boolean>;
  }>,
): Promise<OpenCodeBrokerReadiness> {
  const selectionIdentity = env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
  if (typeof selectionIdentity !== 'string') {
    return { ready: true };
  }
  const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const brokeredProviders: OpenCodeBrokerProvider[] = OPEN_CODE_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  if (brokeredProviders.length === 0) {
    return { ready: true };
  }
  if (!(await brokerStateUsable(env[OPEN_CODE_BROKER_STATE_PATH_ENV]))) {
    return { ready: false, reason: 'broker_daemon_bridge_unreachable' };
  }
  const loadNonce = env[OPEN_CODE_BROKER_LOAD_NONCE_ENV];
  if (typeof loadNonce !== 'string' || loadNonce.trim().length === 0) {
    return { ready: false, reason: 'broker_load_nonce_missing' };
  }
  const happyHomeDir = options?.happyHomeDir ?? configuration.happyHomeDir;
  for (const provider of brokeredProviders) {
    const pluginPath = resolveOpenCodeBrokerPluginPath(provider, happyHomeDir);
    if (!(await fileExists(pluginPath))) {
      return { ready: false, reason: `broker_plugin_file_missing:${provider}` };
    }
  }

  // Real load probe (F4): confirm the broker plugin actually loaded in the OpenCode runtime (it pings
  // the daemon on activation). Fail closed if absent within a bounded wait — the file-existence checks
  // above + the non-functional marker remain the backstop, but a present-yet-unloaded plugin (e.g. an
  // OpenCode plugin-discovery regression) is exactly what this catches.
  const waitMs = typeof options?.handshakeWaitMs === 'number' && options.handshakeWaitMs >= 0
    ? options.handshakeWaitMs
    : DEFAULT_HANDSHAKE_WAIT_MS;
  const verify = options?.verifyLoadHandshake ?? defaultVerifyLoadHandshake;
  const observed = await verify(selectionIdentity, loadNonce.trim(), Date.now() + waitMs).catch(() => false);
  if (!observed) {
    return { ready: false, reason: 'broker_plugin_not_loaded' };
  }

  return { ready: true };
}
