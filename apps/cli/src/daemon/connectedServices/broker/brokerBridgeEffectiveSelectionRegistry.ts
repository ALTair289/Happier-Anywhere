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
    }>;

type StoredBrokerBridgeSelection = Readonly<{
  selection: BrokerBridgeSelection;
  selectionEpoch: number;
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
    if (!groupId || !activeProfileId || !fallbackProfileId || generation === null) return null;
    return {
      kind: 'group',
      serviceId: expectedServiceId,
      groupId,
      activeProfileId,
      fallbackProfileId,
      generation,
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
  const selection = normalizeBrokerBridgeSelection(input.selection, input.serviceId);
  if (!normalizedKey || !selection) {
    throw new Error('invalid_broker_bridge_effective_selection');
  }
  const previous = selectionsByIdentityAndServiceId.get(normalizedKey);
  const next: StoredBrokerBridgeSelection = {
    selection,
    selectionEpoch: (previous?.selectionEpoch ?? 0) + 1,
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
  return stored ?? { selection: fallbackSelection, selectionEpoch: 0 };
}

export function getBrokerBridgeEffectiveSelectionForTest(input: Readonly<{
  selectionIdentity: string;
  serviceId: ConnectedServiceId;
}>): StoredBrokerBridgeSelection | null {
  const normalizedKey = key(input);
  return normalizedKey ? selectionsByIdentityAndServiceId.get(normalizedKey) ?? null : null;
}

export function resetBrokerBridgeEffectiveSelectionsForTests(): void {
  selectionsByIdentityAndServiceId.clear();
}
