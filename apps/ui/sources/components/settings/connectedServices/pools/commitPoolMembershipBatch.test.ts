import { describe, expect, it, vi } from 'vitest';

import {
    commitPoolMembershipBatch,
    computePoolMembershipDiff,
    type MembershipGroupLike,
} from './commitPoolMembershipBatch';

function createStructuredConnectedServiceError(code: string) {
    const error = new Error(code) as Error & { code: string; name: string };
    error.name = 'ConnectedServiceApiError';
    error.code = code;
    return error;
}

const START_GROUP: MembershipGroupLike = {
    generation: 2,
    members: [
        { profileId: 'work', priority: 100 },
        { profileId: 'backup', priority: 200 },
    ],
};

describe('computePoolMembershipDiff', () => {
    it('resolves the exact add + remove set from the target selection', () => {
        expect(computePoolMembershipDiff(['work', 'backup'], ['work', 'extra'])).toEqual({
            toAdd: ['extra'],
            toRemove: ['backup'],
        });
    });

    it('returns an empty diff when the selection matches the current members', () => {
        expect(computePoolMembershipDiff(['work', 'backup'], ['backup', 'work'])).toEqual({
            toAdd: [],
            toRemove: [],
        });
    });
});

describe('commitPoolMembershipBatch', () => {
    it('applies removes then adds sequentially, threading the bumped generation', async () => {
        const removeMember = vi.fn(async () => ({
            generation: 3,
            members: [{ profileId: 'work', priority: 100 }],
        }));
        const addMember = vi.fn(async () => ({
            generation: 4,
            members: [
                { profileId: 'work', priority: 100 },
                { profileId: 'extra', priority: 300 },
            ],
        }));
        const refetchGroup = vi.fn(async () => START_GROUP);

        const result = await commitPoolMembershipBatch({
            group: START_GROUP,
            nextSelectedProfileIds: ['work', 'extra'],
            addMember,
            removeMember,
            refetchGroup,
        });

        expect(removeMember).toHaveBeenCalledWith({ profileId: 'backup', expectedGeneration: 2 });
        // Priority is max(existing) + step; add threads the generation the remove returned.
        expect(addMember).toHaveBeenCalledWith({ profileId: 'extra', priority: 300, expectedGeneration: 3 });
        expect(result.removed).toEqual(['backup']);
        expect(result.added).toEqual(['extra']);
        expect(result.conflictRetryCount).toBe(0);
        expect(refetchGroup).not.toHaveBeenCalled();
    });

    it('applies nothing when the diff is empty', async () => {
        const addMember = vi.fn();
        const removeMember = vi.fn();
        const refetchGroup = vi.fn();

        const result = await commitPoolMembershipBatch({
            group: START_GROUP,
            nextSelectedProfileIds: ['backup', 'work'],
            addMember,
            removeMember,
            refetchGroup,
        });

        expect(addMember).not.toHaveBeenCalled();
        expect(removeMember).not.toHaveBeenCalled();
        expect(result).toEqual({ group: START_GROUP, added: [], removed: [], conflictRetryCount: 0 });
    });

    it('refetches and retries the diff on a generation conflict, threading the fresh generation', async () => {
        const removeMember = vi.fn()
            .mockRejectedValueOnce(createStructuredConnectedServiceError('connect_group_generation_conflict'))
            .mockResolvedValue({ generation: 6, members: [{ profileId: 'work', priority: 100 }] });
        const addMember = vi.fn(async () => ({
            generation: 7,
            members: [
                { profileId: 'work', priority: 100 },
                { profileId: 'extra', priority: 300 },
            ],
        }));
        const refetchGroup = vi.fn(async () => ({
            generation: 5,
            members: [
                { profileId: 'work', priority: 100 },
                { profileId: 'backup', priority: 200 },
            ],
        }));

        const result = await commitPoolMembershipBatch({
            group: START_GROUP,
            nextSelectedProfileIds: ['work', 'extra'],
            addMember,
            removeMember,
            refetchGroup,
        });

        expect(refetchGroup).toHaveBeenCalledTimes(1);
        expect(result.conflictRetryCount).toBe(1);
        // The retried remove threads the refetched generation (5).
        expect(removeMember).toHaveBeenLastCalledWith({ profileId: 'backup', expectedGeneration: 5 });
        expect(addMember).toHaveBeenCalledWith({ profileId: 'extra', priority: 300, expectedGeneration: 6 });
    });

    it('rethrows a non-conflict error without retrying', async () => {
        const removeMember = vi.fn().mockRejectedValue(new Error('network down'));
        const addMember = vi.fn();
        const refetchGroup = vi.fn();

        await expect(commitPoolMembershipBatch({
            group: START_GROUP,
            nextSelectedProfileIds: ['work'],
            addMember,
            removeMember,
            refetchGroup,
        })).rejects.toThrow('network down');
        expect(refetchGroup).not.toHaveBeenCalled();
    });
});
