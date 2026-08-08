import { describe, expect, it, vi } from "vitest";
import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createInTxHarness } from "../../testkit/txHarness";

vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildNewMachineUpdate: vi.fn(),
    buildUpdateMachineUpdate: vi.fn(),
}));
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd") }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/presence/sessionCache", () => ({ activityCache: { invalidateMachine: vi.fn() } }));
vi.mock("@/app/api/socket/sessionRelayAuthCache", () => ({
    invalidateSessionRelayAuthorizationForMachine: vi.fn(),
}));

const dbMocks = createDbMocks({
    machine: ["findMany"],
} as const);
installDbModuleMock(() => ({
    db: dbMocks.db,
    isPrismaErrorCode: () => false,
}));
vi.mock("@/storage/inTx", () => {
    const harness = createInTxHarness(() => ({}));
    return { afterTx: harness.afterTx, inTx: harness.inTx };
});

const machineFindMany = dbMocks.db.machine.findMany;

function machineRow(id: string) {
    return {
        id,
        metadata: "{}",
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
        installationId: null,
        installationPublicKey: null,
        contentPublicKeyFingerprint: null,
        replacedByMachineId: null,
        replacedAt: null,
        replacementReason: null,
        replacementSource: null,
        replacementActorUserId: null,
        seq: 1,
        active: true,
        lastActiveAt: new Date(0),
        revokedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    };
}

describe("GET /v1/machines", () => {
    it("returns the account's complete machine inventory through an explicit column projection", async () => {
        const rows = ["m1", "m2", "m3"].map(machineRow);
        machineFindMany.mockResolvedValue(rows);
        const { machinesRoutes } = await import("./machinesRoutes");
        const { MACHINE_SERIALIZATION_SELECT } = await import("@/app/machines/machineSerialization");

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/machines",
            registerRoutes: (app) => machinesRoutes(app as never),
        });
        const { response } = await route.invoke({ userId: "u1" });

        // The projection is the load-bearing performance guard: without a `select` this
        // foreground-boot endpoint returned every column of every row, including blobs the
        // serializer never emits.
        expect(MACHINE_SERIALIZATION_SELECT).toMatchObject({ id: true, active: true, lastActiveAt: true });

        // The response is a bare array with no pagination metadata, so a row cap here is silent
        // data loss: a client cannot distinguish a complete inventory from a truncated one.
        // The read must therefore stay unbounded.
        const query = machineFindMany.mock.calls[0]?.[0];
        expect(query).not.toHaveProperty("take");
        expect(query).toStrictEqual({
            where: { accountId: "u1" },
            orderBy: { lastActiveAt: "desc" },
            select: MACHINE_SERIALIZATION_SELECT,
        });

        expect((response as Array<{ id: string }>).map((machine) => machine.id)).toEqual(["m1", "m2", "m3"]);
    });
});
