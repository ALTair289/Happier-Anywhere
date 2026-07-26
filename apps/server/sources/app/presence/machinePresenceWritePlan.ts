import type { Prisma } from "@prisma/client";

export function createMachinePresenceUpdateManyArgs(params: Readonly<{
    accountId: string;
    machineId: string;
    timestamp: number;
}>): Prisma.MachineUpdateManyArgs {
    const observedAt = new Date(params.timestamp);
    return {
        where: {
            accountId: params.accountId,
            id: params.machineId,
            revokedAt: null,
            replacedByMachineId: null,
            lastActiveAt: { lte: observedAt },
        },
        data: { lastActiveAt: observedAt, active: true },
    };
}
