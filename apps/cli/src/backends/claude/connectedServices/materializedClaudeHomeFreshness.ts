import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeRefreshTarget } from '@/daemon/connectedServices/runtimeRegistry/registry';
import type { ConnectedServiceMaterializedHomeStalenessInput } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import {
  computeClaudeCodeCredentialSafeTokenFingerprint,
  readClaudeCodeNativeCredential,
} from './nativeAuth/claudeCodeCredentialFile';
import { readClaudeCodeCredentialFreshness } from './nativeAuth/claudeCodeNativeCredentialPayload';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';

type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;

function isExpiryInRefreshWindow(params: Readonly<{
  expiresAt: number | null;
  now: number;
  refreshWindowMs: number;
}>): boolean {
  return typeof params.expiresAt === 'number'
    && Number.isFinite(params.expiresAt)
    && params.expiresAt - params.now <= params.refreshWindowMs;
}

function buildResolvedSelectionForTarget(
  binding: BoundProfile,
  target: ConnectedServiceRuntimeRefreshTarget,
): Parameters<typeof resolveClaudeConnectedServiceStableConfigDir>[0]['selection'] {
  const selection = target.selectionsByServiceId.get(binding.serviceId);
  if (selection?.kind === 'group') {
    return {
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: selection.groupId,
      activeProfileId: selection.activeProfileId,
      fallbackProfileId: selection.fallbackProfileId,
      generation: selection.generation,
      record: null as unknown as ConnectedServiceCredentialRecordV1,
      policy: null,
    };
  }
  if (selection?.kind === 'profile') {
    return {
      kind: 'profile',
      serviceId: 'claude-subscription',
      profileId: selection.profileId,
      record: null as unknown as ConnectedServiceCredentialRecordV1,
    };
  }
  return null;
}

/**
 * Reports whether a live Claude materialized home no longer matches the credential that OWNS it.
 *
 * Ownership rule (live incident 2026-07-08): a SHARED group home is owned by the group's CURRENT
 * canonical active profile — never by any session's spawn-time selection snapshot. Sessions spawned
 * at different generations carry divergent snapshots; comparing (or rewriting) the shared home
 * against a snapshot makes two sessions fight over one file — each rewrite clobbering the other
 * account's token and requesting a session restart, in a loop. All group evaluations therefore
 * resolve the group's canonical active profile first, and fail CLOSED (not stale) when the
 * canonical state cannot be read.
 */
export async function hasStaleClaudeMaterializedHomeForBinding(
  params: ConnectedServiceMaterializedHomeStalenessInput,
): Promise<boolean> {
  if (params.binding.serviceId !== 'claude-subscription') return false;
  for (const target of params.targets) {
    if (target.agentId !== 'claude') continue;
    if (!target.bindings.some((candidate) =>
      candidate.serviceId === params.binding.serviceId
      && candidate.profileId === params.binding.profileId,
    )) {
      continue;
    }
    const selection = target.selectionsByServiceId.get(params.binding.serviceId);
    let expectedProfileId: string | null = params.binding.profileId;
    if (selection?.kind === 'group') {
      expectedProfileId = await params.resolveCanonicalGroupActiveProfileId({
        serviceId: params.binding.serviceId,
        groupId: selection.groupId,
      });
      // Fail closed: without canonical group state we cannot know which profile owns the shared
      // home, so we must neither flag it stale nor let a snapshot-based rewrite fight over it.
      if (!expectedProfileId) continue;
    } else if (selection?.kind === 'profile') {
      expectedProfileId = selection.profileId;
    }
    const claudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir: params.activeServerDir,
      serviceId: params.binding.serviceId,
      fallbackProfileId: params.binding.profileId,
      selection: buildResolvedSelectionForTarget(params.binding, target),
    });
    if (!claudeConfigDir) continue;
    const credential = await readClaudeCodeNativeCredential({
      claudeConfigDir,
      homeDir: params.processEnv.HOME,
      username: params.processEnv.USER,
      diagnosticContext: {
        profileId: expectedProfileId,
        homeKind: selection?.kind === 'group' ? 'group' : 'profile',
      },
    });
    if (!credential) return true;
    const freshness = readClaudeCodeCredentialFreshness(credential.payload, credential.updatedAtMs);
    const homeAccessTokenFingerprint = computeClaudeCodeCredentialSafeTokenFingerprint(freshness.accessToken);
    const expectedAccessTokenFingerprint = await params.resolveStoreAccessTokenFingerprintForProfile(expectedProfileId);
    if (expectedAccessTokenFingerprint && homeAccessTokenFingerprint) {
      if (homeAccessTokenFingerprint !== expectedAccessTokenFingerprint) return true;
      // Home already holds exactly the owning credential — a redistribution would be a no-op, and
      // for near-expiry content the owning profile's own refresh cycle handles rotation.
      continue;
    }
    if (isExpiryInRefreshWindow({
      expiresAt: freshness.expiresAt,
      now: params.now,
      refreshWindowMs: params.refreshWindowMs,
    })) {
      return true;
    }
  }
  return false;
}
