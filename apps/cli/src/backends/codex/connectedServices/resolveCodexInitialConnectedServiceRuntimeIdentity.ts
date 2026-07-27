import {
  findConnectedServiceChildSelection,
  type ConnectedServiceRuntimeAuthMetadataSession,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { readCodexEnvironmentAuthTokens } from '../cli/auth/readCodexEnvironmentAuthState';
import type { CodexConnectedServiceRuntimeIdentitySeed } from './authApplication/types';
import { computeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';

export function resolveCodexInitialConnectedServiceRuntimeIdentity(
  env: Pick<NodeJS.ProcessEnv, string>,
  _session?: ConnectedServiceRuntimeAuthMetadataSession | null,
): CodexConnectedServiceRuntimeIdentitySeed | null {
  // The child selection and auth store are the one materialized launch fact. Session metadata may
  // already describe a newer intended selection, so it must never replace fields in this applied
  // identity tuple.
  const selection = findConnectedServiceChildSelection(env, 'openai-codex');
  if (!selection) return null;

  const authTokens = readCodexEnvironmentAuthTokens(env);
  if (!authTokens.accountId) return null;
  const appliedAccessToken = authTokens.accessToken ?? authTokens.idToken;
  const credentialFingerprint = appliedAccessToken
    ? computeConnectedServiceAccessTokenFingerprint(appliedAccessToken)
    : null;

  if (selection.kind === 'group') {
    return {
      serviceId: 'openai-codex',
      activeAccountId: authTokens.accountId,
      accountLabel: authTokens.accountLabel,
      profileId: selection.activeProfileId,
      groupId: selection.groupId,
      generation: selection.generation,
      credentialRevision: selection.credentialRevision,
      credentialFingerprint,
      source: 'spawn_selection',
    };
  }

  return {
    serviceId: 'openai-codex',
    activeAccountId: authTokens.accountId,
    accountLabel: authTokens.accountLabel,
    profileId: selection.profileId,
    credentialRevision: selection.credentialRevision,
    credentialFingerprint,
    source: 'spawn_selection',
  };
}
