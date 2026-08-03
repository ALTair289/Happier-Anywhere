import type { OpenAiCodexDaemonRefreshSelection } from '@/daemon/controlClient';
import {
  findConnectedServiceBindingSelectionFromSessionMetadata,
  findConnectedServiceChildSelection,
  type ConnectedServiceRuntimeAuthMetadataSession,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';

export type OpenAiCodexDaemonRefreshSelectionResolution = Readonly<{
  selection: OpenAiCodexDaemonRefreshSelection;
  recoveryGroupId: string | null;
}>;

export function resolveOpenAiCodexDaemonRefreshSelection(
  env: Pick<NodeJS.ProcessEnv, string>,
  session?: ConnectedServiceRuntimeAuthMetadataSession | null,
): OpenAiCodexDaemonRefreshSelectionResolution | null {
  const childSelection = findConnectedServiceChildSelection(env, 'openai-codex');
  if (session) {
    const metadataBinding = findConnectedServiceBindingSelectionFromSessionMetadata(session, 'openai-codex');
    if (metadataBinding?.source === 'connected') {
      if (metadataBinding.selection === 'group') {
        if (metadataBinding.profileId) {
          if (
            childSelection?.kind === 'group'
            && childSelection.groupId === metadataBinding.groupId
            && childSelection.activeProfileId === metadataBinding.profileId
          ) {
            return {
              selection: {
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: childSelection.groupId,
                activeProfileId: childSelection.activeProfileId,
                fallbackProfileId: childSelection.fallbackProfileId,
                generation: childSelection.generation,
              },
              recoveryGroupId: childSelection.groupId,
            };
          }
          return {
            selection: {
              kind: 'profile',
              serviceId: 'openai-codex',
              profileId: metadataBinding.profileId,
            },
            recoveryGroupId: metadataBinding.groupId,
          };
        }
      } else {
        return {
          selection: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: metadataBinding.profileId,
          },
          recoveryGroupId: null,
        };
      }
    }
  }

  const selection = childSelection;
  if (!selection || selection.serviceId !== 'openai-codex') return null;
  if (selection.kind === 'profile') {
    return {
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: selection.profileId,
      },
      recoveryGroupId: null,
    };
  }
  return {
    selection: {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: selection.groupId,
      activeProfileId: selection.activeProfileId,
      fallbackProfileId: selection.fallbackProfileId,
      generation: selection.generation,
    },
    recoveryGroupId: selection.groupId,
  };
}

export function createOpenAiCodexBridgeRefreshFailureClassification(
  resolution: OpenAiCodexDaemonRefreshSelectionResolution,
  failure?: Readonly<{
    errorCode?: string;
    credentialHealthStatus?: string;
  }>,
): ConnectedServiceRuntimeFailureClassification {
  const { selection } = resolution;
  return {
    kind: failure?.errorCode === 'connected_service_credential_reconnect_required'
      && failure.credentialHealthStatus === 'needs_reauth'
      ? 'auth_expired'
      : 'refresh_failed',
    serviceId: 'openai-codex',
    profileId: selection.kind === 'group' ? selection.activeProfileId : selection.profileId,
    groupId: selection.kind === 'group' ? selection.groupId : resolution.recoveryGroupId,
    resetsAtMs: null,
    retryAfterMs: null,
    planType: null,
    rateLimits: null,
    source: 'provider_runtime_marker',
  };
}
