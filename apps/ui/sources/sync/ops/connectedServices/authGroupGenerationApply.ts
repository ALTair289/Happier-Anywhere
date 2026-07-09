import type { ConnectedServiceId } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export const CONNECTED_SERVICE_AUTH_GROUP_GENERATION_APPLY_MACHINE_RPC_METHOD =
    RPC_METHODS.DAEMON_CONNECTED_SERVICE_AUTH_GROUP_GENERATION_APPLY;

export type ConnectedServiceAuthGroupGenerationApplyResult = Readonly<{
    ok?: boolean;
    appliedSessionCount?: number;
    restartRequestedSessionCount?: number;
    skippedIdleSessionCount?: number;
    failedSessionCount?: number;
    failures?: ReadonlyArray<Readonly<{ sessionId: string; errorCode: string }>>;
}>;

export async function applyConnectedServiceAuthGroupGenerationOnDaemon(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    generation: number;
}>): Promise<ConnectedServiceAuthGroupGenerationApplyResult> {
    return await machineRpcWithServerScope<ConnectedServiceAuthGroupGenerationApplyResult, {
        serviceId: ConnectedServiceId;
        groupId: string;
        activeProfileId: string;
        generation: number;
        switchReason: 'manual';
    }>({
        machineId: params.machineId,
        serverId: params.serverId ?? null,
        method: CONNECTED_SERVICE_AUTH_GROUP_GENERATION_APPLY_MACHINE_RPC_METHOD,
        payload: {
            serviceId: params.serviceId,
            groupId: params.groupId,
            activeProfileId: params.activeProfileId,
            generation: params.generation,
            switchReason: 'manual',
        },
    });
}
