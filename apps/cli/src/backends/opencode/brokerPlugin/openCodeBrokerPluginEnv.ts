/**
 * Shared env-var names + marker helpers for the Happier OpenCode auth broker.
 *
 * The materializer (connected-services) sets these env vars on the managed `opencode serve`
 * process; the broker plugin (running inside OpenCode's Bun runtime) reads them. Keeping the
 * names in one module keeps the producer (materializer) and consumer (plugin source) in lockstep
 * — a contract test asserts the emitted plugin source references each name.
 *
 * NO secret (refresh token, daemon control token) is ever placed in these env values. The broker
 * obtains access tokens out-of-band from the Happier daemon bridge and reads one matching daemon
 * port + scoped capability snapshot from a minimal broker-state file (0600). That file never contains
 * the daemon control token.
 */

/** JSON map of brokered providers → their refresh selection + account identity (NO tokens). */
export const OPEN_CODE_BROKER_SELECTIONS_ENV = 'HAPPIER_OPENCODE_BROKER_SELECTIONS';

/** Absolute path to the Happier broker-state file. The path itself is not secret. */
export const OPEN_CODE_BROKER_STATE_PATH_ENV = 'HAPPIER_OPENCODE_BROKER_STATE_PATH';

/** Broker plugin version (for cache-keying + drift diagnostics). */
export const OPEN_CODE_BROKER_PLUGIN_VERSION_ENV = 'HAPPIER_OPENCODE_BROKER_PLUGIN_VERSION';

/**
 * Stable connected-service selection identity (the managed-server fingerprint key). The broker reads
 * it to key its load handshake so the preflight (which has the same env) can match the registration.
 * Mirrors `OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV` in the managed-server-env module; kept
 * here as the broker's own constant so the generated plugin source imports nothing from that module.
 */
export const OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV = 'HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY';

/** Per-managed-server-process nonce that correlates the broker load handshake to the current spawn. */
export const OPEN_CODE_BROKER_LOAD_NONCE_ENV = 'HAPPIER_OPENCODE_BROKER_LOAD_NONCE';

/** Stable, non-secret prefix for the broker auth marker stored in `OPENCODE_AUTH_CONTENT`. */
export const OPEN_CODE_BROKER_MARKER_PREFIX = 'happier-broker';

export type OpenCodeBrokerProvider = 'openai' | 'anthropic';

/** Connected service ids brokered through Happier's daemon (NOT the direct API-key services). */
export type OpenCodeBrokerServiceId = 'openai-codex' | 'claude-subscription';

export type OpenCodeBrokerProviderSelection = Readonly<{
  serviceId: OpenCodeBrokerServiceId;
  profileId: string;
  /** Provider account id (e.g. ChatGPT account id) for request headers. Stable, not secret. */
  accountId: string | null;
  /** Provider plan label echoed back for telemetry; optional. */
  planType: string | null;
}>;

export type OpenCodeBrokerSelections = Readonly<
  Partial<Record<OpenCodeBrokerProvider, OpenCodeBrokerProviderSelection>>
>;

export const OPEN_CODE_BROKER_PROVIDERS: readonly OpenCodeBrokerProvider[] = ['openai', 'anthropic'];

/** Build the stable, non-refreshable broker marker stored as the OpenCode auth `key`. */
export function buildOpenCodeBrokerMarker(provider: OpenCodeBrokerProvider, version: string): string {
  return `${OPEN_CODE_BROKER_MARKER_PREFIX}:${provider}:${version}`;
}

export function isOpenCodeBrokerMarker(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${OPEN_CODE_BROKER_MARKER_PREFIX}:`);
}

export function readOpenCodeBrokerMarkerProvider(value: unknown): OpenCodeBrokerProvider | null {
  if (!isOpenCodeBrokerMarker(value)) return null;
  const parts = (value as string).split(':');
  const provider = parts[1];
  return provider === 'openai' || provider === 'anthropic' ? provider : null;
}

export function serializeOpenCodeBrokerSelections(selections: OpenCodeBrokerSelections): string {
  return JSON.stringify(selections);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSelection(value: unknown, provider: OpenCodeBrokerProvider): OpenCodeBrokerProviderSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedServiceId: OpenCodeBrokerServiceId = provider === 'openai' ? 'openai-codex' : 'claude-subscription';
  const serviceId = readString(record.serviceId);
  const profileId = readString(record.profileId);
  if (serviceId !== expectedServiceId || !profileId) return null;
  return {
    serviceId: expectedServiceId,
    profileId,
    accountId: readString(record.accountId),
    planType: readString(record.planType),
  };
}

export function parseOpenCodeBrokerSelections(raw: unknown): OpenCodeBrokerSelections {
  const text = readString(raw);
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const source = parsed as Record<string, unknown>;
  const result: { -readonly [K in OpenCodeBrokerProvider]?: OpenCodeBrokerProviderSelection } = {};
  for (const provider of OPEN_CODE_BROKER_PROVIDERS) {
    const selection = readSelection(source[provider], provider);
    if (selection) result[provider] = selection;
  }
  return result;
}
