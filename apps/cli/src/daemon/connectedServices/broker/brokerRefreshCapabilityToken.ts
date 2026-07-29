import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Scoped broker-refresh capability token (least privilege; plan §2 item 6 / §5 item 3).
 *
 * SHARED, provider-agnostic core used by EVERY connected-service auth broker (the OpenCode plugin and
 * the Pi extension) and by the single daemon bridge preHandler that authorizes them. A broker must NOT
 * receive the daemon's full `controlToken` (which authorizes EVERY control endpoint). Instead the
 * daemon mints a NARROW capability token, scoped to the broker-refresh endpoints only, derived
 * deterministically from the master control token:
 *
 *   token = base64url( HMAC-SHA256(controlToken, BROKER_REFRESH_SCOPE_LABEL) )
 *
 * Properties:
 *  - The broker reads ONLY this derived token from the current 0600 minimal broker-state snapshot;
 *    that provider-visible file never contains the master or a spawn-time token. A leaked broker
 *    token cannot call the broad control
 *    surface (the broad endpoints keep
 *    `requireAuth`, which compares the master token; the scoped token does not match it).
 *  - The daemon re-derives the same value from its in-memory master `controlToken` and constant-time
 *    compares — no extra persisted secret, no parallel token-store mechanism.
 *  - It is rebound to the daemon's master secret: a daemon restart re-mints `controlToken`, which
 *    rotates the scoped token.
 *  - It is PROVIDER-AGNOSTIC: OpenCode and Pi derive the SAME value, so a SINGLE bridge preHandler
 *    authorizes both brokers (no parallel per-provider refresh path / no parallel token mechanism).
 */
/**
 * Scope label folded into the HMAC. Versioned so a future scope/format change is unambiguous and
 * never collides with the master token or another derived capability. Provider-agnostic: every broker
 * (OpenCode, Pi) folds the SAME label so the SAME scoped token authorizes the shared bridge.
 */
export const CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL = 'happier:connected-service-broker-refresh:v1';

/**
 * Derive the scoped broker-refresh capability token from the daemon master control token.
 * Returns an empty string for an empty/blank control token (fail-closed: an empty token never
 * authorizes anything because the verifier rejects empty providers).
 */
export function deriveConnectedServiceBrokerRefreshToken(controlToken: string | null | undefined): string {
  return deriveScopedCapabilityToken(controlToken, CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL);
}

/**
 * Constant-time verification that `provided` is the scoped broker-refresh token for `controlToken`.
 * Fails closed on any empty/blank input. Used by the daemon control server's dedicated broker-refresh
 * preHandler (NOT the broad `requireAuth`).
 */
export function isValidConnectedServiceBrokerRefreshToken(
  provided: string | null | undefined,
  controlToken: string | null | undefined,
): boolean {
  return isValidScopedCapabilityToken(provided, controlToken, CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL);
}

/**
 * Scope label for the EXECUTION-RUN materialization bridge (POST-WAVE-REVIEW F2: least privilege —
 * a leaked run-materialize token must not authorize the broker-refresh endpoints, and vice versa).
 */
export const CONNECTED_SERVICE_RUN_MATERIALIZE_SCOPE_LABEL = 'happier:connected-service-run-materialize:v1';

export function deriveConnectedServiceRunMaterializeToken(controlToken: string | null | undefined): string {
  return deriveScopedCapabilityToken(controlToken, CONNECTED_SERVICE_RUN_MATERIALIZE_SCOPE_LABEL);
}

export function isValidConnectedServiceRunMaterializeToken(
  provided: string | null | undefined,
  controlToken: string | null | undefined,
): boolean {
  return isValidScopedCapabilityToken(provided, controlToken, CONNECTED_SERVICE_RUN_MATERIALIZE_SCOPE_LABEL);
}

/** ONE derivation core for every scoped capability (label = the scope; empty inputs fail closed). */
function deriveScopedCapabilityToken(controlToken: string | null | undefined, scopeLabel: string): string {
  const normalized = typeof controlToken === 'string' ? controlToken.trim() : '';
  if (!normalized) return '';
  return createHmac('sha256', normalized)
    .update(scopeLabel)
    .digest('base64url');
}

function isValidScopedCapabilityToken(
  provided: string | null | undefined,
  controlToken: string | null | undefined,
  scopeLabel: string,
): boolean {
  const expected = deriveScopedCapabilityToken(controlToken, scopeLabel);
  const candidate = typeof provided === 'string' ? provided.trim() : '';
  if (!expected || !candidate) return false;
  // Hash both sides to a fixed length so `timingSafeEqual` never throws on a length mismatch and the
  // comparison stays constant-time regardless of input shape.
  const expectedDigest = createHash('sha256').update(expected).digest();
  const candidateDigest = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}
