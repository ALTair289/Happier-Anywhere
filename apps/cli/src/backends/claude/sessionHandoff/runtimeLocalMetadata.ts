import type { ProviderRuntimeLocalHandoffMetadataBuilder } from '@/backends/types';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/directSessions/resolveClaudeConfigDir';
import { resolveClaudeProjectId } from '@/backends/claude/utils/path';

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const buildClaudeRuntimeLocalHandoffMetadata: ProviderRuntimeLocalHandoffMetadataBuilder = ({
  metadata,
  trackedSession,
  vendorResumeId,
}) => {
  const trimmedVendorResumeId = normalizeOptionalString(vendorResumeId);
  if (!trimmedVendorResumeId) {
    return {};
  }

  const runtimeLocalMetadata: ReturnType<ProviderRuntimeLocalHandoffMetadataBuilder> = {
    claudeSessionId: trimmedVendorResumeId,
  };

  if (trackedSession.spawnOptions?.transcriptStorage !== 'direct') {
    return runtimeLocalMetadata;
  }

  const env = {
    ...process.env,
    ...(trackedSession.spawnOptions.environmentVariables ?? {}),
  };
  const machineId = normalizeOptionalString(metadata.machineId) ?? '';
  const sourcePath = normalizeOptionalString(metadata.path);

  runtimeLocalMetadata.directSessionV1 = {
    v: 1,
    providerId: 'claude',
    machineId,
    remoteSessionId: trimmedVendorResumeId,
    source: {
      kind: 'claudeConfig',
      configDir: resolveConfiguredClaudeConfigDir({ env }),
      ...(sourcePath ? { projectId: resolveClaudeProjectId(sourcePath) } : {}),
    },
    linkedAtMs: Date.now(),
  };

  return runtimeLocalMetadata;
};
