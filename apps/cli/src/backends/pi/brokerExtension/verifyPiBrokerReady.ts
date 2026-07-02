import { readFile, access } from 'node:fs/promises';

import {
  PI_BROKER_DAEMON_STATE_PATH_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_PROVIDERS,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  parsePiBrokerSelections,
} from './piBrokerExtensionEnv';
import { resolvePiBrokerExtensionPath } from './piBrokerExtensionAssets';

export type PiBrokerReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reason: string }>;

/** Bounded total wait for the broker's load handshake to arrive before failing closed. */
const DEFAULT_HANDSHAKE_WAIT_MS = 4_000;
const HANDSHAKE_POLL_INTERVAL_MS = 200;

async function defaultVerifyLoadHandshake(selectionIdentity: string, loadNonce: string, deadlineMs: number): Promise<boolean> {
  // The daemon load-handshake registry is provider-agnostic (keyed by selection identity plus load
  // nonce), so the existing loaded-status control-client query serves the Pi broker too — no new daemon
  // surface or stale-process readiness reuse.
  const { queryDaemonOpenCodeBrokerLoadHandshake } = await import('@/daemon/controlClient');
  for (;;) {
    if (await queryDaemonOpenCodeBrokerLoadHandshake(selectionIdentity, loadNonce).catch(() => false)) return true;
    if (Date.now() >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_POLL_INTERVAL_MS));
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function daemonStateUsable(path: string | undefined): Promise<boolean> {
  if (typeof path !== 'string' || path.trim().length === 0) return false;
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.httpPort === 'number' && typeof parsed.controlToken === 'string' && parsed.controlToken.length > 0;
  } catch {
    return false;
  }
}

/**
 * Fail-closed preflight: verify the Happier Pi broker extension is materialized + reachable for a
 * connected session before startup/prompt commands. For NATIVE sessions (no selection identity) and
 * direct-API-key connected sessions (no brokered provider) it is a strict no-op (`ready: true`).
 *
 * For brokered sessions it confirms (a) the broker extension file exists at the path the launcher passes
 * to Pi's `--extension` arg, (b) the daemon-state bridge target is readable with a control token, and
 * (c) a real load handshake arrived (the extension pings the daemon on activation) within a bounded
 * wait. If any check fails the session MUST be failed with a clear materialization error — never
 * silently fall back to native/upstream auth (the brokered credential carries no real refresh token, so
 * request-time failure is the backstop regardless).
 */
export async function verifyPiBrokerReadyForConnectedSession(
  env: Readonly<Record<string, string>>,
  options?: Readonly<{
    /** The Happier-controlled Pi agent dir (`PI_CODING_AGENT_DIR`). Defaults to the env value. */
    agentDir?: string;
    /** Bounded total wait for the load handshake. Defaults to {@link DEFAULT_HANDSHAKE_WAIT_MS}. */
    handshakeWaitMs?: number;
    /** Injectable load-handshake verifier (test seam). Defaults to a bounded poll of the daemon. */
    verifyLoadHandshake?: (selectionIdentity: string, loadNonce: string, deadlineMs: number) => Promise<boolean>;
  }>,
): Promise<PiBrokerReadiness> {
  const selectionIdentity = env[PI_BROKER_SELECTION_IDENTITY_ENV];
  if (typeof selectionIdentity !== 'string') {
    return { ready: true };
  }
  const selections = parsePiBrokerSelections(env[PI_BROKER_SELECTIONS_ENV]);
  const brokeredProviders = PI_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  if (brokeredProviders.length === 0) {
    return { ready: true };
  }
  if (!(await daemonStateUsable(env[PI_BROKER_DAEMON_STATE_PATH_ENV]))) {
    return { ready: false, reason: 'broker_daemon_bridge_unreachable' };
  }
  const loadNonce = env[PI_BROKER_LOAD_NONCE_ENV];
  if (typeof loadNonce !== 'string' || loadNonce.trim().length === 0) {
    return { ready: false, reason: 'broker_load_nonce_missing' };
  }
  const agentDir = options?.agentDir ?? env.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== 'string' || agentDir.trim().length === 0) {
    return { ready: false, reason: 'broker_agent_dir_missing' };
  }
  if (!(await fileExists(resolvePiBrokerExtensionPath(agentDir)))) {
    return { ready: false, reason: 'broker_extension_file_missing' };
  }

  const waitMs = typeof options?.handshakeWaitMs === 'number' && options.handshakeWaitMs >= 0
    ? options.handshakeWaitMs
    : DEFAULT_HANDSHAKE_WAIT_MS;
  const verify = options?.verifyLoadHandshake ?? defaultVerifyLoadHandshake;
  const observed = await verify(selectionIdentity, loadNonce.trim(), Date.now() + waitMs).catch(() => false);
  if (!observed) {
    return { ready: false, reason: 'broker_extension_not_loaded' };
  }

  return { ready: true };
}
