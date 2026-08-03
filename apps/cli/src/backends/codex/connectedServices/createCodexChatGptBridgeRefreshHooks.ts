import type {
  ConnectedServiceBridgeRefreshCapabilities,
  ConnectedServiceBridgeRefreshProfileHooks,
} from '@/daemon/connectedServices/refresh/bridgeRefreshHooks';

import {
  resolveCodexChatGptAuthTokensRefreshProfileId,
  type CodexChatGptAuthTokensRefreshResponse,
  type CodexChatGptAuthTokensRefreshSelection,
} from './codexChatGptAuthTokensRefreshBridgeContract';
import { materializeCodexChatGptRefreshBridgeSelection } from './materializeCodexChatGptRefreshBridgeSelection';
import type { ConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

/**
 * Narrow a daemon-resolved current child selection (already scoped to `openai-codex`) into the Codex
 * bridge selection contract. The shapes are identical; this restates the serviceId literal so the
 * downstream Codex materializer keeps its exact contract type.
 */
function toCodexChatGptAuthTokensRefreshSelection(
  selection: ConnectedServiceChildSelection,
): CodexChatGptAuthTokensRefreshSelection {
  if (selection.kind === 'group') {
    return {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: selection.groupId,
      activeProfileId: selection.activeProfileId,
      fallbackProfileId: selection.fallbackProfileId,
      generation: selection.generation,
    };
  }
  return { kind: 'profile', serviceId: 'openai-codex', profileId: selection.profileId };
}

/**
 * CS-FIX-1: the Codex ChatGPT bridge-refresh hook. It owns the Codex-specific bits the generic
 * skeleton delegates — the ChatGPT selection/profile mapping, the `chatgptPlanType`/`chatgptAccountId`
 * response shape, and the post-rotation home rematerialization fallback — while the shared
 * orchestration stays in `ConnectedServiceRefreshCoordinator.refreshServiceTokensForBridge`.
 */
export function createCodexChatGptBridgeRefreshHooks(input: Readonly<{
  chatgptPlanType: string | null;
  capabilities: ConnectedServiceBridgeRefreshCapabilities;
}>): ConnectedServiceBridgeRefreshProfileHooks<CodexChatGptAuthTokensRefreshResponse> {
  const { capabilities } = input;
  return {
    serviceId: 'openai-codex',
    resolveProfileId: (selection) =>
      resolveCodexChatGptAuthTokensRefreshProfileId(toCodexChatGptAuthTokensRefreshSelection(selection)),
    probeCurrentToken: async (binding) => {
      // F6: on a cold broker cache-miss return the CURRENT access token if it is still valid,
      // instead of rotating the single-use refresh token on every new OpenCode process.
      const source = await capabilities.readCredentialSource(binding);
      if (!source || source.record.kind !== 'oauth' || !capabilities.isOauthSourceStillValid(source)) {
        return { kind: 'needs_refresh' };
      }
      const accessToken = source.record.oauth.accessToken;
      const providerAccountId = source.record.oauth.providerAccountId;
      return {
        kind: 'adoptable',
        accessToken,
        buildResponse: () => ({
          accessToken,
          chatgptAccountId: providerAccountId,
          chatgptPlanType: input.chatgptPlanType,
          ...(source.revisionSemantics === 'revisioned'
            ? { credentialRevision: source.credentialRevision }
            : {}),
        }),
      };
    },
    finalizeRefreshedResponse: async ({ selection, credential, credentialRevision }) => {
      const codexSelection = toCodexChatGptAuthTokensRefreshSelection(selection);
      const profileId = resolveCodexChatGptAuthTokensRefreshProfileId(codexSelection);
      const rematerializedTargets = await capabilities.rematerializeTargets({
        serviceId: 'openai-codex',
        profileId,
      });
      if (rematerializedTargets.length === 0) {
        await materializeCodexChatGptRefreshBridgeSelection({
          selection: codexSelection,
          record: credential,
          activeServerDir: capabilities.activeServerDir,
          baseDir: capabilities.baseDir,
          accountSettings: capabilities.accountSettings,
          processEnv: capabilities.processEnv,
        });
      }
      return {
        accessToken: credential.oauth.accessToken,
        chatgptAccountId: credential.oauth.providerAccountId,
        chatgptPlanType: input.chatgptPlanType,
        credentialRevision,
      };
    },
  };
}
