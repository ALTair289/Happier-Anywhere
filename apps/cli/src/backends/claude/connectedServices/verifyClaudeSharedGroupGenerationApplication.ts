import type { ConnectedServiceGenerationApplicationProofInput } from '@/daemon/connectedServices/credentials/lifecycleTypes';

import { readClaudeConnectedServiceHomeProvenance } from './claudeConnectedServiceHomeProvenance';
import { verifyClaudeCodeNativeAuth } from './nativeAuth/verifyClaudeCodeNativeAuth';

export async function verifyClaudeSharedGroupGenerationApplication(
  input: ConnectedServiceGenerationApplicationProofInput,
) {
  if (input.serviceId !== 'claude-subscription') return { status: 'unavailable' as const };
  const claudeConfigDir = input.environmentVariables.CLAUDE_CONFIG_DIR?.trim() ?? '';
  if (!claudeConfigDir || input.credentialRevision === null) return { status: 'unavailable' as const };
  const provenance = await readClaudeConnectedServiceHomeProvenance(claudeConfigDir);
  if (
    provenance?.selection.kind !== 'group'
    || provenance.selection.groupId !== input.groupId
    || provenance.selection.activeProfileId !== input.profileId
    || provenance.credentialProfileId !== input.profileId
    || provenance.generation !== input.generation
    || provenance.credentialRevision !== input.credentialRevision
    || provenance.credentialFingerprint === undefined
    || (
      input.credentialFingerprint !== null
      && input.credentialFingerprint !== undefined
      && provenance.credentialFingerprint !== input.credentialFingerprint
    )
  ) {
    return { status: 'unavailable' as const };
  }
  const nativeAuth = await verifyClaudeCodeNativeAuth({ claudeConfigDir });
  if (nativeAuth.status !== 'ok') return { status: 'unavailable' as const };
  return {
    status: 'verified' as const,
    source: 'claude_shared_group_home_provenance',
    sharedAuthSurfaceId: input.groupId,
    credentialRevision: input.credentialRevision,
    credentialFingerprint: provenance.credentialFingerprint,
  };
}
