/**
 * OpenCode broker capability-token surface — a THIN alias over the SHARED, provider-agnostic core.
 *
 * The derivation/verification logic + env name + scope label live in
 * `@/daemon/connectedServices/broker/brokerRefreshCapabilityToken` so that the OpenCode plugin, the Pi
 * extension, and the SINGLE daemon bridge preHandler (`requireBrokerRefreshAuth`) all derive and verify
 * the SAME scoped token (no parallel per-provider refresh path / no duplicated crypto). This module
 * keeps the OpenCode-local names as aliases purely so existing OpenCode call sites read naturally.
 *
 * See the shared module for the full rationale (least privilege; the broker never receives the master
 * control token; a daemon restart rotates the scoped token).
 */
export {
  CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV as OPEN_CODE_BROKER_REFRESH_TOKEN_ENV,
  CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL as OPEN_CODE_BROKER_REFRESH_SCOPE_LABEL,
  deriveConnectedServiceBrokerRefreshToken as deriveOpenCodeBrokerRefreshToken,
  isValidConnectedServiceBrokerRefreshToken as isValidOpenCodeBrokerRefreshToken,
} from '@/daemon/connectedServices/broker/brokerRefreshCapabilityToken';
