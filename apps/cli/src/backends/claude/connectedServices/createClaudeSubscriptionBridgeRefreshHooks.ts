import type {
  ConnectedServiceBridgeRefreshCapabilities,
  ConnectedServiceBridgeRefreshProfileHooks,
} from '@/daemon/connectedServices/refresh/bridgeRefreshHooks';

import type { ClaudeSubscriptionAuthTokensRefreshResponse } from './claudeSubscriptionAuthTokensRefreshBridgeContract';

/**
 * CS-FIX-1: the Claude subscription bridge-refresh hook. It owns the Claude-specific bits the generic
 * skeleton delegates — the setup-token short-circuit (long-lived access tokens are returned as-is,
 * nothing to rotate), the `anthropicAccountId`/`expiresAt` response shape, and expiry resolution —
 * while the shared orchestration stays in
 * `ConnectedServiceRefreshCoordinator.refreshServiceTokensForBridge`. Post-rotation distribution is
 * handled BY CONSTRUCTION on the 'refreshed' completion path (RR-1), so no finalize materialization
 * is required here.
 */
export function createClaudeSubscriptionBridgeRefreshHooks(input: Readonly<{
  capabilities: ConnectedServiceBridgeRefreshCapabilities;
}>): ConnectedServiceBridgeRefreshProfileHooks<ClaudeSubscriptionAuthTokensRefreshResponse> {
  const { capabilities } = input;
  return {
    serviceId: 'claude-subscription',
    resolveProfileId: (selection) =>
      selection.kind === 'group' ? selection.activeProfileId : selection.profileId,
    probeCurrentToken: async (binding) => {
      const source = await capabilities.readCredentialSource(binding);
      if (!source) {
        throw new Error('connected_service_claude_refresh_unavailable');
      }
      if (source.record.kind === 'token') {
        // Setup-tokens are long-lived access tokens; nothing to refresh (forceRefresh is moot).
        return {
          kind: 'non_refreshable',
          accessToken: source.record.token.token,
          response: {
            accessToken: source.record.token.token,
            anthropicAccountId: source.record.token.providerAccountId,
            expiresAt: source.record.expiresAt ?? null,
          },
        };
      }
      // F6: adopt the CURRENT access token if still valid; the shared skeleton owns the force gate.
      if (source.record.kind !== 'oauth' || !capabilities.isOauthSourceStillValid(source)) {
        return { kind: 'needs_refresh' };
      }
      const accessToken = source.record.oauth.accessToken;
      const providerAccountId = source.record.oauth.providerAccountId;
      const expiresAt = capabilities.resolveSourceExpiresAt(source);
      return {
        kind: 'adoptable',
        accessToken,
        buildResponse: () => ({
          accessToken,
          anthropicAccountId: providerAccountId,
          expiresAt,
        }),
      };
    },
    finalizeRefreshedResponse: async ({ credential }) => ({
      accessToken: credential.oauth.accessToken,
      anthropicAccountId: credential.oauth.providerAccountId,
      expiresAt: credential.expiresAt ?? null,
    }),
  };
}
