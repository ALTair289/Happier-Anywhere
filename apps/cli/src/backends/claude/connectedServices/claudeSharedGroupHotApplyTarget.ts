import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import type { ClaudeSubscriptionNativeAuthSelectionDescriptor } from './nativeAuth/materializeClaudeCodeNativeAuth';
import {
  readClaudeRuntimeAuthSharedGroupSurfaceMetadata,
  type ClaudeRuntimeAuthSharedGroupSurfaceMetadata,
} from './claudeRuntimeAuthSharedGroupSurfaceMetadata';

export type ClaudeSharedGroupHotApplyTarget = Readonly<{
  record: ConnectedServiceCredentialRecordV1 & { kind: 'oauth'; serviceId: 'claude-subscription' };
  metadata: ClaudeRuntimeAuthSharedGroupSurfaceMetadata;
  selectionDescriptor: Extract<ClaudeSubscriptionNativeAuthSelectionDescriptor, { kind: 'group' }>;
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
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  if (!record || !metadata || !groupId || !activeProfileId) return null;
  return {
    record,
    metadata,
    selectionDescriptor: {
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId,
      activeProfileId,
      fallbackProfileId: readString(selectionRecord.fallbackProfileId) ?? activeProfileId,
      generation: readNumber(selectionRecord.generation) ?? 0,
    },
  };
}
