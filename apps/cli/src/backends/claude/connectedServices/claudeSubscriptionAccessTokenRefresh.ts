import { refreshDaemonClaudeSubscriptionAnthropicAuthTokensForBridge } from '@/daemon/controlClient';
import {
  findConnectedServiceChildSelection,
  type ConnectedServiceChildSelection,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { computeClaudeCodeCredentialSafeTokenFingerprint } from './nativeAuth/claudeCodeCredentialFile';

import type { ClaudeSubscriptionAuthTokensRefreshSelection } from './claudeSubscriptionAuthTokensRefreshBridgeContract';

export type ClaudeSubscriptionAccessTokenRefreshCapability =
  Readonly<{ mode: 'daemon_callback' }>;

export type ClaudeSubscriptionAccessTokenRefreshCallback = (
  opts: { signal: AbortSignal },
) => Promise<string | null>;

export function resolveClaudeSubscriptionRefreshSelectionFromChildSelection(
  selection: ConnectedServiceChildSelection | null | undefined,
): ClaudeSubscriptionAuthTokensRefreshSelection | null {
  if (!selection || selection.serviceId !== 'claude-subscription') return null;
  if (selection.kind === 'profile') {
    return {
      kind: 'profile',
      serviceId: 'claude-subscription',
      profileId: selection.profileId,
    };
  }
  return {
    kind: 'group',
    serviceId: 'claude-subscription',
    groupId: selection.groupId,
    activeProfileId: selection.activeProfileId,
    fallbackProfileId: selection.fallbackProfileId,
    generation: selection.generation,
  };
}

export function resolveClaudeSubscriptionRefreshSelectionFromEnv(
  env: Pick<NodeJS.ProcessEnv, string>,
): ClaudeSubscriptionAuthTokensRefreshSelection | null {
  return resolveClaudeSubscriptionRefreshSelectionFromChildSelection(
    findConnectedServiceChildSelection(env, 'claude-subscription'),
  );
}

export function createClaudeSubscriptionAccessTokenRefreshCallback(params: Readonly<{
  sessionId: string;
  selection: ClaudeSubscriptionAuthTokensRefreshSelection;
}>): ClaudeSubscriptionAccessTokenRefreshCallback {
  let lastDeliveredAccessTokenFingerprint: string | null = null;
  return async ({ signal }) => {
    if (signal.aborted) return null;
    const refreshed = await refreshDaemonClaudeSubscriptionAnthropicAuthTokensForBridge({
      sessionId: params.sessionId,
      selection: params.selection,
      // Load-bearing SDK assumption: getOAuthToken is re-invoked only after auth failure of the
      // previously delivered token. If a benign re-invocation ever happens, the daemon bridge's
      // adopt-fresh-first check is the safety net when the store has already advanced.
      forceRefresh: lastDeliveredAccessTokenFingerprint !== null,
      ...(lastDeliveredAccessTokenFingerprint
        ? { failingAccessTokenFingerprint: lastDeliveredAccessTokenFingerprint }
        : {}),
    });
    lastDeliveredAccessTokenFingerprint = computeClaudeCodeCredentialSafeTokenFingerprint(refreshed.accessToken);
    return signal.aborted ? null : refreshed.accessToken;
  };
}
