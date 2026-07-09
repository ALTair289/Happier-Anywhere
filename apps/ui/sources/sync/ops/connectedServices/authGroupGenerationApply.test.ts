import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

describe('applyConnectedServiceAuthGroupGenerationOnDaemon', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes manual auth group generation apply through the daemon machine RPC contract', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            appliedSessionCount: 1,
            restartRequestedSessionCount: 0,
        });

        const {
            applyConnectedServiceAuthGroupGenerationOnDaemon,
            CONNECTED_SERVICE_AUTH_GROUP_GENERATION_APPLY_MACHINE_RPC_METHOD,
        } = await import('./authGroupGenerationApply');

        await expect(applyConnectedServiceAuthGroupGenerationOnDaemon({
            machineId: 'machine-1',
            serverId: 'server-1',
            serviceId: 'claude-subscription',
            groupId: 'manual-pool',
            activeProfileId: 'work',
            generation: 7,
        })).resolves.toEqual({
            ok: true,
            appliedSessionCount: 1,
            restartRequestedSessionCount: 0,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: CONNECTED_SERVICE_AUTH_GROUP_GENERATION_APPLY_MACHINE_RPC_METHOD,
            payload: {
                serviceId: 'claude-subscription',
                groupId: 'manual-pool',
                activeProfileId: 'work',
                generation: 7,
                switchReason: 'manual',
            },
        });
    });
});
