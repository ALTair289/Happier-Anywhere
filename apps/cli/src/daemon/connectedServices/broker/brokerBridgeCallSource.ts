/**
 * Shared, provider-agnostic bridge-call source for connected-service auth brokers.
 *
 * The OpenCode broker plugin (Bun runtime) and the Pi broker extension (jiti runtime) both need the
 * IDENTICAL daemon-bridge call: read the daemon HTTP port from the 0600 daemon-state file, read the
 * SCOPED broker-refresh capability token from the runtime env, resolve the brokered selection, and
 * POST to the shared daemon bridge to obtain a fresh ACCESS token (the daemon is the sole refresher;
 * NO refresh token is ever present in the runtime).
 *
 * Factoring this into one stringified builder keeps the two runtime artifacts in lockstep (a wire-shape
 * change touches a single place) without forcing a shared plugin API (OpenCode's plugin API and Pi's
 * extension API differ; only the bridge CALL is common).
 *
 * The emitted source is self-contained ESM-statement JS that imports only `node:fs` `readFileSync` and
 * uses `fetch`/`process` globals. It defines:
 *   - `fetchAccessTokenFromBridge(forceRefresh)` → `{ accessToken, accountId, expiresAt }`
 *   - `readDaemonHttpPort()`, `readScopedToken()` (also used by a broker's load handshake)
 * Callers must place `import { readFileSync } from "node:fs";` at the top of the assembled module.
 */

/**
 * Load-handshake path: a broker pings this once on activation so the daemon can record that the
 * runtime artifact actually loaded. Shared across brokers (the daemon registry is keyed by the stable
 * selection identity, not by provider).
 */
export const CONNECTED_SERVICE_BROKER_LOADED_HANDSHAKE_PATH =
  '/connected-service-auth/broker/loaded';

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the shared bridge-call JS for one provider, parameterized by the broker's own env-var names so
 * the OpenCode and Pi brokers keep their distinct env namespaces while sharing the call logic.
 */
export function buildBrokerBridgeCallSource(params: Readonly<{
  /** Stable broker selection tag used to read this provider's entry from the selections env. */
  providerTag: string;
  /** Daemon bridge path this provider-owned broker caller should POST to. */
  bridgePath: string;
  /** Connected-service id to send inside the bridge selection body. */
  serviceId: string;
  /** Env var holding the JSON map of brokered providers → selection identity. */
  selectionsEnv: string;
  /** Env var holding the absolute path to the daemon-state file (`httpPort` is read at call time). */
  daemonStatePathEnv: string;
  /** Env var holding the SCOPED broker-refresh capability token (NEVER the master control token). */
  refreshTokenEnv: string;
  /** Env var holding the broker version (for the bridge sessionId only). */
  pluginVersionEnv: string;
  /** Fallback broker version literal (when the env var is unset). */
  pluginVersion: string;
  /** Stable tag for the synthetic bridge `sessionId` (e.g. `opencode-broker` / `pi-broker`). */
  sessionTag: string;
  /** Optional request body field used by providers whose bridge accepts a plan hint. */
  planTypeBodyField?: string | null;
  /** Response fields to check, in order, for a provider account id. */
  accountIdResultFields?: readonly string[];
}>): string {
  const accountIdResultFields = params.accountIdResultFields ?? ['accountId'];
  return `const PROVIDER = ${jsString(params.providerTag)};
const BRIDGE_PATH = ${jsString(params.bridgePath)};
const SERVICE_ID = ${jsString(params.serviceId)};
const SELECTIONS_ENV = ${jsString(params.selectionsEnv)};
const DAEMON_STATE_PATH_ENV = ${jsString(params.daemonStatePathEnv)};
const REFRESH_TOKEN_ENV = ${jsString(params.refreshTokenEnv)};
const PLUGIN_VERSION_ENV = ${jsString(params.pluginVersionEnv)};
const PLUGIN_VERSION = ${jsString(params.pluginVersion)};
const SESSION_TAG = ${jsString(params.sessionTag)};
const PLAN_TYPE_BODY_FIELD = ${params.planTypeBodyField ? jsString(params.planTypeBodyField) : 'null'};
const ACCOUNT_ID_RESULT_FIELDS = ${JSON.stringify(accountIdResultFields)};

function readJsonEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Read ONLY the daemon HTTP port from the 0600 state file. The broker deliberately does NOT read the
// master controlToken (least privilege): it authenticates with the SCOPED broker-refresh token from
// its env, so even reading the state file cannot grant it the broad control surface.
function readDaemonHttpPort() {
  const path = process.env[DAEMON_STATE_PATH_ENV];
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("happier_broker_daemon_state_path_missing");
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw new Error("happier_broker_daemon_state_unreadable");
  }
  const httpPort = parsed && typeof parsed.httpPort === "number" ? parsed.httpPort : null;
  if (!httpPort) throw new Error("happier_broker_daemon_state_incomplete");
  return httpPort;
}

// The scoped broker-refresh capability token (NOT the master controlToken), injected via env.
function readScopedToken() {
  const token = process.env[REFRESH_TOKEN_ENV];
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("happier_broker_scoped_token_missing");
  }
  return token.trim();
}

function resolveSelection() {
  const selections = readJsonEnv(SELECTIONS_ENV) || {};
  const selection = selections[PROVIDER];
  if (!selection || typeof selection.profileId !== "string" || selection.profileId.length === 0) {
    throw new Error("happier_broker_selection_missing");
  }
  return selection;
}

// Calls the Happier daemon bridge for an ACCESS token. The daemon returns the CURRENT access token
// when it is still valid and rotates ONLY when near-expiry or when forceRefresh is set (the 401-retry
// path). Returns { accessToken, accountId, expiresAt }.
async function fetchAccessTokenFromBridge(forceRefresh) {
  const httpPort = readDaemonHttpPort();
  const scopedToken = readScopedToken();
  const selection = resolveSelection();
  const body = {
    sessionId: SESSION_TAG + ":" + PROVIDER + ":" + (process.env[PLUGIN_VERSION_ENV] || PLUGIN_VERSION),
    selection: { kind: "profile", serviceId: SERVICE_ID, profileId: selection.profileId },
    forceRefresh: forceRefresh === true,
  };
  if (PLAN_TYPE_BODY_FIELD) body[PLAN_TYPE_BODY_FIELD] = selection.planType || null;
  const response = await fetch("http://127.0.0.1:" + httpPort + BRIDGE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-happier-daemon-token": scopedToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error("happier_broker_bridge_status_" + response.status);
  }
  const json = await response.json().catch(() => null);
  const result = json && json.result ? json.result : null;
  const accessToken = result && typeof result.accessToken === "string" ? result.accessToken : "";
  if (!accessToken) throw new Error("happier_broker_bridge_no_access_token");
  let accountId = selection.accountId || null;
  if (result) {
    for (const field of ACCOUNT_ID_RESULT_FIELDS) {
      if (typeof result[field] === "string" && result[field].length > 0) {
        accountId = result[field];
        break;
      }
    }
  }
  const expiresAt = result && typeof result.expiresAt === "number" ? result.expiresAt : null;
  return { accessToken: accessToken, accountId: accountId, expiresAt: expiresAt };
}`;
}
