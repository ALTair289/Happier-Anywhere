import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';

import {
  buildClaudeConnectedServiceHomeProvenance,
  matchesClaudeConnectedServiceHomeProvenance,
  readClaudeConnectedServiceHomeProvenance,
  writeClaudeConnectedServiceHomeProvenance,
} from './claudeConnectedServiceHomeProvenance';
import type { ClaudeSharedGroupHotApplyTarget } from './claudeSharedGroupHotApplyTarget';
import { materializeClaudeCodeNativeAuth } from './nativeAuth/materializeClaudeCodeNativeAuth';
import { resolveClaudeCodeCredentialsFilePath } from './nativeAuth/claudeCodeCredentialFile';
import { verifyClaudeCodeNativeAuth } from './nativeAuth/verifyClaudeCodeNativeAuth';

/**
 * Live Claude group adoption owns only the stable group's credential surface. Initial spawn
 * materialization may construct the full home, but switching an already-running group must not
 * replace or sanitize unrelated runtime state beneath CLAUDE_CONFIG_DIR.
 */
export async function materializeClaudeSharedGroupRuntimeAuth(
  target: ClaudeSharedGroupHotApplyTarget,
) {
  return await withConnectedServiceStateSharingDestinationLock(
    target.metadata.runtimeClaudeConfigDir,
    async () => {
      const expectedProvenance = buildClaudeConnectedServiceHomeProvenance({
        record: target.record,
        selectionDescriptor: target.selectionDescriptor,
        credentialRevision: target.credentialRevision,
      });
      const existingProvenance = await readClaudeConnectedServiceHomeProvenance(
        target.metadata.runtimeClaudeConfigDir,
      );
      if (
        matchesClaudeConnectedServiceHomeProvenance(expectedProvenance, existingProvenance)
        && (await verifyClaudeCodeNativeAuth({
          claudeConfigDir: target.metadata.runtimeClaudeConfigDir,
        })).status === 'ok'
      ) {
        return {
          status: 'materialized' as const,
          env: { CLAUDE_CONFIG_DIR: target.metadata.runtimeClaudeConfigDir },
          diagnostics: [],
          credentialPath: resolveClaudeCodeCredentialsFilePath(target.metadata.runtimeClaudeConfigDir),
        };
      }
      const materialized = await materializeClaudeCodeNativeAuth({
        record: target.record,
        claudeConfigDir: target.metadata.runtimeClaudeConfigDir,
        preserveNewerExistingCredential: false,
        homeDir: process.env.HOME,
        username: process.env.USER,
        diagnosticContext: {
          profileId: target.selectionDescriptor.activeProfileId,
          homeKind: 'group',
        },
      });
      if (materialized.status !== 'materialized') return materialized;

      await writeClaudeConnectedServiceHomeProvenance({
        claudeConfigDir: target.metadata.runtimeClaudeConfigDir,
        provenance: expectedProvenance,
      });
      return materialized;
    },
    { providerId: 'claude' },
  );
}
