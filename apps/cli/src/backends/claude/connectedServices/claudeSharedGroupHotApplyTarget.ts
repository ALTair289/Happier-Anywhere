import {
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';

import type { ClaudeSubscriptionNativeAuthSelectionDescriptor } from './nativeAuth/materializeClaudeCodeNativeAuth';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import {
  readClaudeRuntimeAuthSharedGroupSurfaceMetadata,
  type ClaudeRuntimeAuthSharedGroupSurfaceMetadata,
} from './claudeRuntimeAuthSharedGroupSurfaceMetadata';

export type ClaudeSharedGroupHotApplyTarget = Readonly<{
  record: ConnectedServiceCredentialRecordV1 & { kind: 'oauth'; serviceId: 'claude-subscription' };
  metadata: ClaudeRuntimeAuthSharedGroupSurfaceMetadata;
  selectionDescriptor: Extract<ClaudeSubscriptionNativeAuthSelectionDescriptor, { kind: 'group' }>;
  credentialRevision: ConnectedServiceCredentialRevisionV1;
  validateCurrentBeforeMutation?: () => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function readClaudeSubscriptionOauthRecord(
  value: unknown,
): (ConnectedServiceCredentialRecordV1 & { kind: 'oauth'; serviceId: 'claude-subscription' }) | null {
  const record = readRecord(value);
  if (!record) return null;
  return record.serviceId === 'claude-subscription' && record.kind === 'oauth'
    ? record as ConnectedServiceCredentialRecordV1 & { kind: 'oauth'; serviceId: 'claude-subscription' }
    : null;
}

export function resolveClaudeSharedGroupHotApplyTarget(
  selection: unknown,
): ClaudeSharedGroupHotApplyTarget | null {
  const selectionRecord = readRecord(selection);
  if (!selectionRecord) return null;
  const serviceId = readString(selectionRecord.serviceId);
  if (serviceId !== null && serviceId !== 'claude-subscription') return null;
  const record = readClaudeSubscriptionOauthRecord(selectionRecord.record);
  const metadata = readClaudeRuntimeAuthSharedGroupSurfaceMetadata(selection);
  const groupId = readString(selectionRecord.groupId);
  const activeProfileId = readString(selectionRecord.activeProfileId);
  const generation = readNumber(selectionRecord.generation);
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(selectionRecord.credentialRevision);
  if (!record || !metadata || !groupId || !activeProfileId || generation === null || !credentialRevision.success) return null;
  return {
    record,
    metadata,
    credentialRevision: credentialRevision.data,
    selectionDescriptor: {
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId,
      activeProfileId,
      fallbackProfileId: readString(selectionRecord.fallbackProfileId) ?? activeProfileId,
      generation,
    },
  };
}
