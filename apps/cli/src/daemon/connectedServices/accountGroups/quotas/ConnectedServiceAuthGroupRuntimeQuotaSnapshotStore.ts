import type {
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from './projection';

type SnapshotKeyInput = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
}>;

type ProfileSnapshotKeyInput = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

function snapshotKey(input: SnapshotKeyInput): string {
  return `${input.serviceId}\0${input.groupId}\0${input.profileId}`;
}

function profileSnapshotKey(input: ProfileSnapshotKeyInput): string {
  return `${input.serviceId}\0${input.profileId}`;
}

function readFetchedAt(snapshot: ConnectedServiceQuotaSnapshotV1 | null | undefined): number {
  const fetchedAt = Number(snapshot?.fetchedAt ?? 0);
  return Number.isFinite(fetchedAt) && fetchedAt >= 0 ? fetchedAt : 0;
}

function selectFreshestSnapshot(
  first: ConnectedServiceQuotaSnapshotV1 | null | undefined,
  second: ConnectedServiceQuotaSnapshotV1 | null | undefined,
): ConnectedServiceQuotaSnapshotV1 | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return readFetchedAt(second) > readFetchedAt(first) ? second : first;
}

function shouldRecordSnapshot(
  existing: ConnectedServiceQuotaSnapshotV1 | null | undefined,
  incoming: ConnectedServiceQuotaSnapshotV1,
): boolean {
  if (!existing) return true;
  return readFetchedAt(incoming) >= readFetchedAt(existing);
}

export class ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore {
  private readonly snapshotsByKey = new Map<string, ConnectedServiceQuotaSnapshotV1>();
  private readonly snapshotsByProfileKey = new Map<string, ConnectedServiceQuotaSnapshotV1>();

  recordSnapshot(input: SnapshotKeyInput & Readonly<{ snapshot: ConnectedServiceQuotaSnapshotV1 }>): void {
    const key = snapshotKey(input);
    if (shouldRecordSnapshot(this.snapshotsByKey.get(key), input.snapshot)) {
      this.snapshotsByKey.set(key, input.snapshot);
    }
    this.recordProfileSnapshot(input);
  }

  recordProfileSnapshot(input: ProfileSnapshotKeyInput & Readonly<{ snapshot: ConnectedServiceQuotaSnapshotV1 }>): void {
    const key = profileSnapshotKey(input);
    if (shouldRecordSnapshot(this.snapshotsByProfileKey.get(key), input.snapshot)) {
      this.snapshotsByProfileKey.set(key, input.snapshot);
    }
  }

  getSnapshot(input: SnapshotKeyInput): ConnectedServiceQuotaSnapshotV1 | null {
    return selectFreshestSnapshot(
      this.snapshotsByKey.get(snapshotKey(input)),
      this.snapshotsByProfileKey.get(profileSnapshotKey(input)),
    );
  }

  buildMemberStates(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    capturedAtMs: number;
  }>): Map<string, ConnectedServiceAuthGroupMemberRuntimeState> {
    void input.capturedAtMs;
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
    const prefix = `${input.serviceId}\0${input.groupId}\0`;
    for (const [key, snapshot] of this.snapshotsByKey.entries()) {
      if (!key.startsWith(prefix)) continue;
      const profileId = key.slice(prefix.length);
      const profileSnapshot = this.snapshotsByProfileKey.get(profileSnapshotKey({ serviceId: input.serviceId, profileId }));
      states.set(profileId, buildMemberState(selectFreshestSnapshot(snapshot, profileSnapshot) ?? snapshot));
    }
    const profilePrefix = `${input.serviceId}\0`;
    for (const [key, snapshot] of this.snapshotsByProfileKey.entries()) {
      if (!key.startsWith(profilePrefix)) continue;
      const profileId = key.slice(profilePrefix.length);
      if (states.has(profileId)) continue;
      states.set(profileId, buildMemberState(snapshot));
    }
    return states;
  }
}

function buildMemberState(snapshot: ConnectedServiceQuotaSnapshotV1): ConnectedServiceAuthGroupMemberRuntimeState {
  return buildConnectedServiceAuthGroupRuntimeStateFromMeters({
    capturedAtMs: snapshot.fetchedAt,
    meters: snapshot.meters,
  });
}
