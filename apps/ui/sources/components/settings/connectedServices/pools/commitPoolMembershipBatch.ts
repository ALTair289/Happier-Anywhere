import { isConnectedServiceApiErrorCode } from '@/sync/api/account/connectedServiceApiError';

import { POOL_MEMBER_PRIORITY_STEP } from './commitPoolMemberReorder';

const DEFAULT_MAX_CONFLICT_RETRIES = 3;

export type MembershipMember = Readonly<{ profileId: string; priority: number }>;

export type MembershipGroupLike = Readonly<{
    generation: number;
    members: ReadonlyArray<MembershipMember>;
}>;

export type PoolMembershipDiff = Readonly<{
    toAdd: ReadonlyArray<string>;
    toRemove: ReadonlyArray<string>;
}>;

/**
 * Resolves the exact membership change needed to realize `nextSelectedIds`:
 * ids selected but not currently members are added, current members no longer
 * selected are removed. Order-insensitive and duplicate-safe (Set-backed).
 */
export function computePoolMembershipDiff(
    currentMemberIds: ReadonlyArray<string>,
    nextSelectedIds: ReadonlyArray<string>,
): PoolMembershipDiff {
    const current = new Set(currentMemberIds);
    const next = new Set(nextSelectedIds);
    const toAdd = [...next].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !next.has(id));
    return { toAdd, toRemove };
}

/**
 * Next priority for an appended member: one step past the highest existing
 * priority (mirrors the single-add flow's `resolveNextMemberPriority`), never
 * below the base step so a fresh pool starts at a stable slot.
 */
function resolveNextPriority(members: ReadonlyArray<MembershipMember>, step: number): number {
    if (members.length === 0) return Math.max(step, 100);
    const maxPriority = members.reduce(
        (max, member) => Math.max(max, Number.isFinite(member.priority) ? member.priority : 0),
        0,
    );
    return Math.max(step, maxPriority + step);
}

export type CommitPoolMembershipBatchParams = Readonly<{
    /** Authoritative group at edit-start (carries `generation` + `members`). */
    group: MembershipGroupLike;
    /** The target membership as a set of profile ids. */
    nextSelectedProfileIds: ReadonlyArray<string>;
    /**
     * Boundary: adds a single member. Must return the updated group so the bumped
     * `generation` threads into the next call. Wire to
     * `addConnectedServiceAuthGroupMemberV3({ profileId, priority, enabled, expectedGeneration })`.
     */
    addMember: (input: Readonly<{
        profileId: string;
        priority: number;
        expectedGeneration: number;
    }>) => Promise<MembershipGroupLike>;
    /**
     * Boundary: removes a single member. Must return the updated group so the
     * bumped `generation` threads into the next call. Wire to
     * `removeConnectedServiceAuthGroupMemberV3({ profileId, expectedGeneration })`.
     */
    removeMember: (input: Readonly<{
        profileId: string;
        expectedGeneration: number;
    }>) => Promise<MembershipGroupLike>;
    /** Boundary: refetches the authoritative group after a generation conflict. */
    refetchGroup: () => Promise<MembershipGroupLike>;
    priorityStep?: number;
    maxConflictRetries?: number;
}>;

export type CommitPoolMembershipBatchResult = Readonly<{
    group: MembershipGroupLike;
    added: ReadonlyArray<string>;
    removed: ReadonlyArray<string>;
    conflictRetryCount: number;
}>;

/**
 * Applies a pool-membership diff by removing then adding members SEQUENTIALLY,
 * threading the bumped `expectedGeneration` each call returns (there is no batch
 * endpoint, so sequential is the only safe path). On
 * `connect_group_generation_conflict` it refetches the authoritative group and
 * recomputes the remaining diff against the fresh members — so an already-applied
 * remove/add is not repeated — retrying up to `maxConflictRetries`.
 */
export async function commitPoolMembershipBatch(
    params: CommitPoolMembershipBatchParams,
): Promise<CommitPoolMembershipBatchResult> {
    const step = params.priorityStep ?? POOL_MEMBER_PRIORITY_STEP;
    const maxConflictRetries = params.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;

    let group = params.group;
    let conflictRetryCount = 0;

    for (let attempt = 0; ; attempt += 1) {
        const currentIds = group.members.map((member) => member.profileId);
        const { toAdd, toRemove } = computePoolMembershipDiff(currentIds, params.nextSelectedProfileIds);
        if (toAdd.length === 0 && toRemove.length === 0) {
            return { group, added: [], removed: [], conflictRetryCount };
        }

        const added: string[] = [];
        const removed: string[] = [];
        // Priority for appended members is derived from the group at attempt start
        // (removals only lower the max, so it stays collision-free) and incremented
        // per add — deterministic and independent of the server-echoed member list.
        let priority = resolveNextPriority(group.members, step);
        try {
            let generation = group.generation;
            for (const profileId of toRemove) {
                const updated = await params.removeMember({ profileId, expectedGeneration: generation });
                generation = updated.generation;
                group = updated;
                removed.push(profileId);
            }
            for (const profileId of toAdd) {
                const updated = await params.addMember({ profileId, priority, expectedGeneration: generation });
                generation = updated.generation;
                group = updated;
                priority += step;
                added.push(profileId);
            }
            return { group, added, removed, conflictRetryCount };
        } catch (error) {
            const isConflict = isConnectedServiceApiErrorCode(error, 'connect_group_generation_conflict');
            if (isConflict && attempt < maxConflictRetries) {
                conflictRetryCount += 1;
                group = await params.refetchGroup();
                continue;
            }
            throw error;
        }
    }
}
