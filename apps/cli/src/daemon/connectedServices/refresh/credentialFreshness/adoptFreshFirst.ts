import {
  computeConnectedServiceAccessTokenFingerprint,
  normalizeConnectedServiceAccessTokenFingerprint,
  type ConnectedServiceAccessTokenFingerprint,
} from './tokenFingerprint';

export type ForcedRefreshFreshnessDecision =
  | Readonly<{ kind: 'rotate'; reason: 'not_forced' | 'missing_failing_token' | 'store_token_failed' | 'store_token_not_adoptable' }>
  | Readonly<{ kind: 'adopt_current'; failingAccessTokenFingerprint: ConnectedServiceAccessTokenFingerprint }>;

export function resolveForcedRefreshFreshnessDecision(params: Readonly<{
  force: boolean;
  currentAccessToken: string | null;
  currentTokenAdoptable: boolean;
  failingAccessTokenFingerprint?: string | null | undefined;
}>): ForcedRefreshFreshnessDecision {
  if (!params.force) return { kind: 'rotate', reason: 'not_forced' };
  if (!params.currentTokenAdoptable) return { kind: 'rotate', reason: 'store_token_not_adoptable' };
  const failingFingerprint = normalizeConnectedServiceAccessTokenFingerprint(params.failingAccessTokenFingerprint);
  if (!failingFingerprint) return { kind: 'rotate', reason: 'missing_failing_token' };
  const currentAccessToken = typeof params.currentAccessToken === 'string' ? params.currentAccessToken : '';
  const currentFingerprint = currentAccessToken
    ? computeConnectedServiceAccessTokenFingerprint(currentAccessToken)
    : null;
  return currentFingerprint === failingFingerprint
    ? { kind: 'rotate', reason: 'store_token_failed' }
    : { kind: 'adopt_current', failingAccessTokenFingerprint: failingFingerprint };
}
