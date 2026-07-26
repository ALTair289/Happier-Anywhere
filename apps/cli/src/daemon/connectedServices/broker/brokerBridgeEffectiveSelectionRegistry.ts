import type { ConnectedServiceId } from '@happier-dev/protocol';

type BrokerBridgeSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      credentialRevision?: string;
      credentialFingerprint?: string;
    }>;

type StoredBrokerBridgeSelection = Readonly<{
  availability: 'available';
  selection: BrokerBridgeSelection;
  selectionEpoch: number;
}> | Readonly<{
  availability: 'unavailable';
  selection: null;
  selectionEpoch: number;
  groupId: string;
  unavailableReason: 'group_missing' | 'active_profile_missing';
}>;

const selectionsByIdentityAndServiceId = new Map<string, StoredBrokerBridgeSelection>();

function key(input: Readonly<{ selectionIdentity: string; serviceId: string }>): string | null {
  const selectionIdentity = input.selectionIdentity.trim();
  const serviceId = input.serviceId.trim();
  if (!selectionIdentity || !serviceId) return null;
  return `${selectionIdentity}\0${serviceId}`;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeBrokerBridgeSelection(
  selection: unknown,
  expectedServiceId: ConnectedServiceId,
  requireExactGroupIdentity = false,
): BrokerBridgeSelection | null {
  const record = readRecord(selection);
  if (!record) return null;
  const serviceId = readString(record.serviceId);
  if (serviceId !== expectedServiceId) return null;

  if (record.kind === 'group') {
    const groupId = readString(record.groupId);
    const activeProfileId = readString(record.activeProfileId ?? record.profileId);
    const fallbackProfileId = readString(record.fallbackProfileId) ?? activeProfileId;
    const generation = readNonNegativeInteger(record.generation);
    const credentialRevision = readString(record.credentialRevision);
    const credentialFingerprint = readString(record.credentialFingerprint);
    if (
      !groupId
      || !activeProfileId
      || !fallbackProfileId
      || generation === null
      || (requireExactGroupIdentity && (!credentialRevision || !credentialFingerprint))
    ) return null;
    return {
      kind: 'group',
      serviceId: expectedServiceId,
      groupId,
      activeProfileId,
      fallbackProfileId,
      generation,
      ...(credentialRevision ? { credentialRevision } : {}),
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
    };
  }

  const profileId = readString(record.profileId);
  if (!profileId) return null;
  return {
    kind: 'profile',
    serviceId: expectedServiceId,
    profileId,
  };
}

export function updateBrokerBridgeEffectiveSelection(input: Readonly<{
  selectionIdentity: string;
  serviceId: ConnectedServiceId;
  selection: unknown;
}>): StoredBrokerBridgeSelection {
  const normalizedKey = key(input);
  const selection = normalizeBrokerBridgeSelection(input.selection, input.serviceId, true);
  if (!normalizedKey || !selection) {
    throw new Error('invalid_broker_bridge_effective_selection');
  }
  const previous = selectionsByIdentityAndServiceId.get(normalizedKey);
  const next: StoredBrokerBridgeSelection = {
    availability: 'available',
    selection,
    selectionEpoch: (previous?.selectionEpoch ?? 0) + 1,
  };
  selectionsByIdentityAndServiceId.set(normalizedKey, next);
  return next;
}

export function markBrokerBridgeEffectiveSelectionUnavailable(input: Readonly<{
  selectionIdentity: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  unavailableReason: 'group_missing' | 'active_profile_missing';
}>): StoredBrokerBridgeSelection {
  const normalizedKey = key(input);
  const groupId = input.groupId.trim();
  if (!normalizedKey || !groupId) throw new Error('invalid_broker_bridge_unavailable_selection');
  const previous = selectionsByIdentityAndServiceId.get(normalizedKey);
  const next: StoredBrokerBridgeSelection = {
    availability: 'unavailable',
    selection: null,
    selectionEpoch: (previous?.selectionEpoch ?? 0) + 1,
    groupId,
    unavailableReason: input.unavailableReason,
  };
  selectionsByIdentityAndServiceId.set(normalizedKey, next);
  return next;
}

export function resolveBrokerBridgeEffectiveSelection(input: Readonly<{
  selectionIdentity?: string | null;
  serviceId: ConnectedServiceId;
  selection: unknown;
}>): StoredBrokerBridgeSelection {
  const fallbackSelection = normalizeBrokerBridgeSelection(input.selection, input.serviceId);
  if (!fallbackSelection) throw new Error('invalid_broker_bridge_selection');
  const selectionIdentity = typeof input.selectionIdentity === 'string' ? input.selectionIdentity.trim() : '';
  const normalizedKey = selectionIdentity ? key({ selectionIdentity, serviceId: input.serviceId }) : null;
  const stored = normalizedKey ? selectionsByIdentityAndServiceId.get(normalizedKey) : null;
  return stored ?? { availability: 'available', selection: fallbackSelection, selectionEpoch: 0 };
}

export function getBrokerBridgeEffectiveSelection(input: Readonly<{
  selectionIdentity: string;
  serviceId: ConnectedServiceId;
}>): StoredBrokerBridgeSelection | null {
  const normalizedKey = key(input);
  return normalizedKey ? selectionsByIdentityAndServiceId.get(normalizedKey) ?? null : null;
}

/**
 * A missing entry means the request-time broker has not needed credentials yet, so its immutable
 * spawn selection remains the effective fallback. Callers use this only after independently
 * proving that materialized spawn selection matches current group generation and revision.
 */
export function isBrokerBridgeCurrentGroupTruthCompatible(input: Readonly<{
  selectionIdentity: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  generation: number;
  credentialRevision: string;
}>): boolean {
  const current = getBrokerBridgeEffectiveSelection(input);
  if (current === null) return true;
  if (current.availability !== 'available' || current.selection.kind !== 'group') return false;
  return current.selection.groupId === input.groupId
    && current.selection.generation === input.generation
    && current.selection.credentialRevision === input.credentialRevision;
}

export function getBrokerBridgeEffectiveSelectionForTest(input: Readonly<{
  selectionIdentity: string;
  serviceId: ConnectedServiceId;
}>): StoredBrokerBridgeSelection | null {
  return getBrokerBridgeEffectiveSelection(input);
}

export function resetBrokerBridgeEffectiveSelectionsForTests(): void {
  selectionsByIdentityAndServiceId.clear();
}
