import { buildMachineActivityEphemeral } from "@/app/events/eventRouter";
import { db } from "@/storage/db";

export type MachinePresenceSnapshotSocket = Readonly<{
    emit: (event: string, payload: unknown) => unknown;
}>;

/**
 * Send the account's persisted machine presence to one freshly connected user-scoped socket.
 *
 * Machine liveness is published as an ephemeral (`machine-activity`), which by definition only
 * reaches sockets that were already connected when it was emitted. It therefore never appears in
 * `/v2/changes`, so a client returning from the background had no way to learn machine readiness
 * until the daemon's next 20s keep-alive — or until it pulled `/v1/machines`, one of the more
 * expensive reads on the surface, on the same critical path.
 *
 * The server already persists this presence (`recordMachineAlive` flushes it in batches), so the
 * snapshot is a projected read of a fact that exists rather than a new source of truth. It carries
 * the persisted `active` / `lastActiveAt` exactly as the alive and timeout paths publish them, so
 * the ephemeral channel keeps a single meaning. Revoked and replaced machines are excluded: they are
 * not part of the fleet a client can use.
 *
 * The read is deliberately unbounded. A cap would silently drop machines from a snapshot the client
 * treats as the complete current fleet, and there is no metadata in the ephemeral channel that could
 * tell it otherwise; the three-column projection is what keeps this cheap.
 */
export async function publishMachinePresenceSnapshot(params: Readonly<{
    accountId: string;
    socket: MachinePresenceSnapshotSocket;
}>): Promise<void> {
    const machines = await db.machine.findMany({
        where: {
            accountId: params.accountId,
            revokedAt: null,
            replacedByMachineId: null,
        },
        select: { id: true, active: true, lastActiveAt: true },
        orderBy: { lastActiveAt: "desc" },
    });

    for (const machine of machines) {
        params.socket.emit(
            "ephemeral",
            buildMachineActivityEphemeral(machine.id, machine.active, machine.lastActiveAt.getTime()),
        );
    }
}
