import { beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import {
    decodeBase64,
    encodeBase64,
    signMachineInstallationProof,
} from "@happier-dev/protocol";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createInTxHarness } from "../../testkit/txHarness";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const markAccountChanged = vi.fn(async (_tx: unknown, params: { entityId: string }) => params.entityId === "m1" ? 122 : 123);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

const emitUpdate = vi.fn();
const disconnectReplacedMachineSocket = vi.fn();
const getConnections = vi.fn(() => new Set([
    {
        connectionType: "machine-scoped",
        machineId: "m1",
        socket: { connected: true, disconnect: disconnectReplacedMachineSocket },
    },
    {
        connectionType: "machine-scoped",
        machineId: "m2",
        socket: { connected: true },
    },
]));
const buildNewMachineUpdate = vi.fn((_machine: unknown, seq: number, id: string) => ({
    id,
    seq,
    body: { t: "new-machine" },
}));
const buildUpdateMachineUpdate = vi.fn((machineId: string, seq: number, id: string, _metadata?: unknown, _daemonState?: unknown, extra?: unknown) => ({
    id,
    seq,
    body: { t: "update-machine", machineId, ...(extra && typeof extra === "object" ? extra : {}) },
}));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate, getConnections },
    buildNewMachineUpdate,
    buildUpdateMachineUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd") }));
vi.mock("@/app/presence/sessionCache", () => ({ activityCache: { invalidateMachine: vi.fn() } }));

const dbMocks = createDbMocks({
    machine: ["findFirst", "findUnique"],
    account: ["findUnique", "updateMany"],
} as const);
const txDbMocks = createDbMocks({
    accessKey: ["deleteMany"],
    automationAssignment: ["deleteMany"],
    machine: ["create", "findFirst", "update", "updateMany"],
} as const);

installDbModuleMock(() => ({
    db: dbMocks.db,
    isPrismaErrorCode: (error: unknown, code: string) =>
        typeof error === "object" && error !== null && "code" in error && error.code === code,
}));

const harness = createInTxHarness(() => ({
    accessKey: txDbMocks.db.accessKey,
    automationAssignment: txDbMocks.db.automationAssignment,
    machine: txDbMocks.db.machine,
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: harness.afterTx,
    inTx: harness.inTx,
}));

const contentPublicKeyFingerprint = `content-public-key-sha256:${"a".repeat(64)}`;
const oldContentPublicKeyFingerprint = `content-public-key-sha256:${"b".repeat(64)}`;
const newContentPublicKeyFingerprint = `content-public-key-sha256:${"c".repeat(64)}`;

const baseMachine = {
    id: "m1",
    accountId: "u1",
    metadata: "old-meta",
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 0,
    dataEncryptionKey: null,
    seq: 1,
    active: false,
    lastActiveAt: new Date(1),
    revokedAt: null,
    createdAt: new Date(1),
    updatedAt: new Date(1),
    installationId: "install-1",
    installationPublicKey: null,
    contentPublicKeyFingerprint,
    replacedByMachineId: null,
    replacedAt: null,
    replacementReason: null,
    replacementSource: null,
    replacementActorUserId: null,
};

function createProof(params: Readonly<{
    installationId: string;
    machineId: string;
    replacesMachineId?: string;
    replacementReason?: string;
    contentPublicKeyFingerprint?: string;
    accountId?: string;
}>) {
    const keyPair = tweetnacl.sign.keyPair();
    const payload = {
        version: 1 as const,
        installationId: params.installationId,
        machineId: params.machineId,
        ...(params.replacesMachineId ? { replacesMachineId: params.replacesMachineId } : {}),
        ...(params.replacementReason ? { replacementReason: params.replacementReason } : {}),
        ...(params.contentPublicKeyFingerprint ? { contentPublicKeyFingerprint: params.contentPublicKeyFingerprint } : {}),
        ...(params.accountId ? { accountId: params.accountId } : {}),
    };

    return {
        publicKey: encodeBase64(keyPair.publicKey, "base64url"),
        proof: signMachineInstallationProof({ payload, privateKey: keyPair.secretKey }),
    };
}

function createPostMachinesRoute() {
    return import("./machinesRoutes").then(({ machinesRoutes }) => createRouteTestBuilder({
        method: "POST",
        path: "/v1/machines",
        registerRoutes(app) {
            machinesRoutes(app as unknown as Parameters<typeof machinesRoutes>[0]);
        },
    }));
}

function createManualReplacementRoute() {
    return import("./machinesRoutes").then(({ machinesRoutes }) => createRouteTestBuilder({
        method: "POST",
        path: "/v1/machines/:oldMachineId/replacement",
        registerRoutes(app) {
            machinesRoutes(app as unknown as Parameters<typeof machinesRoutes>[0]);
        },
    }));
}

function createManualReplacementDeleteRoute() {
    return import("./machinesRoutes").then(({ machinesRoutes }) => createRouteTestBuilder({
        method: "DELETE",
        path: "/v1/machines/:oldMachineId/replacement",
        registerRoutes(app) {
            machinesRoutes(app as unknown as Parameters<typeof machinesRoutes>[0]);
        },
    }));
}

type MachineCreateMockArgs = Readonly<{
    data: Record<string, unknown> & {
        metadataVersion?: number;
        daemonStateVersion?: number;
    };
}>;

type MachineUpdateMockArgs = Readonly<{
    where?: {
        accountId_id?: {
            id?: string;
            accountId?: string;
        };
    };
    data: Record<string, unknown>;
}>;

describe("machinesRoutes machine replacement", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getConnections.mockReturnValue(new Set([
            {
                connectionType: "machine-scoped",
                machineId: "m1",
                socket: { connected: true, disconnect: disconnectReplacedMachineSocket },
            },
            {
                connectionType: "machine-scoped",
                machineId: "m2",
                socket: { connected: true },
            },
        ]));
        dbMocks.reset();
        txDbMocks.reset();
        dbMocks.db.account.findUnique.mockResolvedValue({ contentPublicKey: null });
        dbMocks.db.account.updateMany.mockResolvedValue({ count: 0 });
        dbMocks.db.machine.findUnique.mockResolvedValue(null);
        dbMocks.db.machine.findFirst.mockResolvedValue(null);
        txDbMocks.db.accessKey.deleteMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.automationAssignment.deleteMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.machine.create.mockImplementation(async (args: MachineCreateMockArgs) => ({
            ...baseMachine,
            ...args.data,
            seq: 0,
            metadataVersion: args.data.metadataVersion ?? 1,
            daemonStateVersion: args.data.daemonStateVersion ?? 0,
            lastActiveAt: new Date(10),
            createdAt: new Date(10),
            updatedAt: new Date(10),
        }));
        txDbMocks.db.machine.findFirst.mockResolvedValue(baseMachine);
        txDbMocks.db.machine.update.mockImplementation(async (args: MachineUpdateMockArgs) => ({
            ...baseMachine,
            id: args.where?.accountId_id?.id ?? baseMachine.id,
            accountId: args.where?.accountId_id?.accountId ?? baseMachine.accountId,
            ...args.data,
            updatedAt: new Date(20),
        }));
        txDbMocks.db.machine.updateMany.mockResolvedValue({ count: 1 });
    });

    it("creates machines with installation identity and encryption keyspace fields", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });

        const route = await createPostMachinesRoute();
        const { response } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(txDbMocks.db.machine.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                installationId: "install-1",
                installationPublicKey: expect.any(Uint8Array),
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            }),
        }));
        expect(response).toEqual(expect.objectContaining({
            machine: expect.objectContaining({
                id: "m2",
                installationId: "install-1",
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
                replacedByMachineId: null,
            }),
        }));
    });

    it("rejects malformed content public key fingerprints before machine writes", async () => {
        const route = await createPostMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "meta",
                dataEncryptionKey: null,
                contentPublicKeyFingerprint: "sha256:not-valid",
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-params", reason: "content_public_key_fingerprint_invalid" });
        expect(txDbMocks.db.machine.create).not.toHaveBeenCalled();
    });

    it("rejects existing machine registration with a different installation id", async () => {
        const existingProof = createProof({
            installationId: "install-1",
            machineId: "m1",
            contentPublicKeyFingerprint,
            accountId: "u1",
        });
        const incomingProof = createProof({
            installationId: "install-2",
            machineId: "m1",
            contentPublicKeyFingerprint,
            accountId: "u1",
        });
        const existingMachine = {
            ...baseMachine,
            id: "m1",
            installationId: "install-1",
            installationPublicKey: decodeBase64(existingProof.publicKey, "base64url"),
            contentPublicKeyFingerprint,
        };
        dbMocks.db.machine.findFirst.mockResolvedValueOnce(existingMachine);

        const route = await createPostMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: "old-meta",
                dataEncryptionKey: null,
                installationId: "install-2",
                installationPublicKey: incomingProof.publicKey,
                installationProof: incomingProof.proof,
                contentPublicKeyFingerprint,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-params", reason: "installation_id_mismatch" });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("applies explicit valid replacement when creating the new machine", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });

        const route = await createPostMachinesRoute();
        const { response } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(txDbMocks.db.machine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                id: "m1",
                OR: [
                    { replacedByMachineId: null },
                    { replacedByMachineId: "m2" },
                ],
            },
            data: expect.objectContaining({
                active: false,
                replacedByMachineId: "m2",
                replacedAt: expect.any(Date),
                replacementReason: "reauth",
                replacementSource: "automatic",
                replacementActorUserId: null,
            }),
        }));
        expect(disconnectReplacedMachineSocket).toHaveBeenCalledWith(true);
        expect(disconnectReplacedMachineSocket.mock.invocationCallOrder[0]).toBeGreaterThan(
            txDbMocks.db.machine.updateMany.mock.invocationCallOrder[0]!,
        );
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityId: "m1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityId: "m2" }));
        expect(response).toEqual(expect.objectContaining({
            machineReplacement: {
                status: "applied",
                replacesMachineId: "m1",
            },
        }));
    });

    it("applies explicit valid replacement when the new machine row already exists", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });
        dbMocks.db.machine.findFirst.mockResolvedValueOnce({
            ...baseMachine,
            id: "m2",
            metadata: "new-meta",
            installationPublicKey: decodeBase64(publicKey, "base64url"),
        });
        txDbMocks.db.machine.findFirst.mockResolvedValueOnce(baseMachine);

        const route = await createPostMachinesRoute();
        await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(txDbMocks.db.machine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                id: "m1",
                OR: [
                    { replacedByMachineId: null },
                    { replacedByMachineId: "m2" },
                ],
            },
            data: expect.objectContaining({
                active: false,
                replacedByMachineId: "m2",
                replacementReason: "reauth",
                replacementSource: "automatic",
                replacementActorUserId: null,
            }),
        }));
    });

    it("applies explicit valid replacement when concurrent create loses to an existing new machine row", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });
        dbMocks.db.machine.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                ...baseMachine,
                id: "m2",
                metadata: "new-meta",
                installationPublicKey: decodeBase64(publicKey, "base64url"),
            });
        txDbMocks.db.machine.create.mockRejectedValueOnce(Object.assign(new Error("P2002"), { code: "P2002" }));
        txDbMocks.db.machine.findFirst.mockResolvedValueOnce(baseMachine);

        const route = await createPostMachinesRoute();
        await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(txDbMocks.db.machine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                id: "m1",
                OR: [
                    { replacedByMachineId: null },
                    { replacedByMachineId: "m2" },
                ],
            },
            data: expect.objectContaining({
                active: false,
                replacedByMachineId: "m2",
                replacementReason: "reauth",
                replacementSource: "automatic",
                replacementActorUserId: null,
            }),
        }));
    });

    it("treats repeated automatic replacement for the same old and new machines as idempotent success", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });
        txDbMocks.db.machine.findFirst.mockResolvedValueOnce({
            ...baseMachine,
            id: "m1",
            replacedByMachineId: "m2",
            replacedAt: new Date(10),
            replacementReason: "reauth",
            replacementSource: "automatic",
        });

        const route = await createPostMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(409);
        expect(response).toEqual(expect.objectContaining({
            machine: expect.objectContaining({ id: "m2" }),
        }));
        expect(txDbMocks.db.machine.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", id: "m1" }),
            data: expect.objectContaining({ replacedByMachineId: "m2" }),
        }));
    });

    it("returns conflict when automatic replacement targets an old machine already replaced by another machine", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m3",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });
        txDbMocks.db.machine.findFirst.mockResolvedValueOnce({
            ...baseMachine,
            id: "m1",
            replacedByMachineId: "m2",
            replacedAt: new Date(10),
            replacementReason: "reauth",
            replacementSource: "automatic",
        });

        const route = await createPostMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m3",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "invalid-params", reason: "old_machine_replacement_conflict" });
        expect(txDbMocks.db.machine.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", id: "m1" }),
            data: expect.objectContaining({ replacedByMachineId: "m3" }),
        }));
    });

    it("treats automatic replacement as idempotent when the atomic write loses to the same replacement", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });
        txDbMocks.db.machine.updateMany.mockResolvedValueOnce({ count: 0 });
        txDbMocks.db.machine.findFirst
            .mockResolvedValueOnce({ ...baseMachine, id: "m1", replacedByMachineId: null })
            .mockResolvedValueOnce({
                ...baseMachine,
                id: "m1",
                replacedByMachineId: "m2",
                replacedAt: new Date(20),
                replacementReason: "reauth",
                replacementSource: "automatic",
            });

        const route = await createPostMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(409);
        expect(response).toEqual(expect.objectContaining({
            machine: expect.objectContaining({ id: "m2" }),
        }));
        expect(txDbMocks.db.machine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", id: "m1" }),
            data: expect.objectContaining({ replacedByMachineId: "m2" }),
        }));
    });

    it("returns conflict when the automatic replacement atomic write loses to a different replacement", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m3",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });
        txDbMocks.db.machine.updateMany.mockResolvedValueOnce({ count: 0 });
        txDbMocks.db.machine.findFirst
            .mockResolvedValueOnce({ ...baseMachine, id: "m1", replacedByMachineId: null })
            .mockResolvedValueOnce({
                ...baseMachine,
                id: "m1",
                replacedByMachineId: "m2",
                replacedAt: new Date(20),
                replacementReason: "reauth",
                replacementSource: "automatic",
            });

        const route = await createPostMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m3",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "invalid-params", reason: "old_machine_replacement_conflict" });
        expect(txDbMocks.db.machine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", id: "m1" }),
            data: expect.objectContaining({ replacedByMachineId: "m3" }),
        }));
    });

    it("does not replace same-installation machines without an explicit replacement candidate", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            accountId: "u1",
        });

        const route = await createPostMachinesRoute();
        await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                contentPublicKeyFingerprint: contentPublicKeyFingerprint,
            },
        });

        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("registers a guarded manual replacement repair endpoint", async () => {
        const route = await createManualReplacementRoute();

        expect(route.routeExists).toBe(true);
        if (!route.routeExists) return;

        await route.invoke({
            userId: "u1",
            params: { oldMachineId: "m1" },
            body: {
                replacementMachineId: "m2",
                confirmActiveOldMachine: false,
            },
        });

        expect(txDbMocks.db.machine.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_id: { accountId: "u1", id: "m1" } },
            data: expect.objectContaining({
                active: false,
                replacedByMachineId: "m2",
                replacementReason: "manual_repair",
                replacementSource: "manual",
                replacementActorUserId: "u1",
            }),
        }));
    });

    it("blocks manual replacement when the target machine has no exact connected daemon socket", async () => {
        getConnections.mockReturnValueOnce(new Set());
        const route = await createManualReplacementRoute();

        const { response, reply } = await route.invoke({
            userId: "u1",
            params: { oldMachineId: "m1" },
            body: {
                replacementMachineId: "m2",
                confirmActiveOldMachine: false,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "machine_not_ready", reason: "replacement_machine_not_connected" });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("allows manual replacement when exact target readiness is observed through shared presence", async () => {
        getConnections.mockReturnValueOnce(new Set());
        dbMocks.db.machine.findFirst.mockResolvedValueOnce({
            ...baseMachine,
            id: "m2",
            active: true,
            lastActiveAt: new Date(Date.now()),
        });

        const route = await createManualReplacementRoute();

        await route.invoke({
            userId: "u1",
            params: { oldMachineId: "m1" },
            body: {
                replacementMachineId: "m2",
                confirmActiveOldMachine: false,
            },
        });

        expect(txDbMocks.db.machine.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_id: { accountId: "u1", id: "m1" } },
            data: expect.objectContaining({
                replacedByMachineId: "m2",
                replacementSource: "manual",
            }),
        }));
    });

    it("blocks manual replacement across incompatible encryption keyspaces", async () => {
        txDbMocks.db.machine.findFirst
            .mockResolvedValueOnce({
                ...baseMachine,
                id: "m1",
                contentPublicKeyFingerprint: oldContentPublicKeyFingerprint,
            })
            .mockResolvedValueOnce({
                ...baseMachine,
                id: "m2",
                active: true,
                contentPublicKeyFingerprint: newContentPublicKeyFingerprint,
            });

        const route = await createManualReplacementRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            params: { oldMachineId: "m1" },
            body: {
                replacementMachineId: "m2",
                confirmActiveOldMachine: false,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-params", reason: "content_public_key_fingerprint_mismatch" });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("requires explicit confirmation before manually replacing an active old machine", async () => {
        txDbMocks.db.machine.findFirst
            .mockResolvedValueOnce({
                ...baseMachine,
                id: "m1",
                active: true,
            })
            .mockResolvedValueOnce({
                ...baseMachine,
                id: "m2",
                active: true,
            });

        const route = await createManualReplacementRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            params: { oldMachineId: "m1" },
            body: {
                replacementMachineId: "m2",
                confirmActiveOldMachine: false,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({ error: "invalid-params", reason: "old_machine_active_confirmation_required" });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("registers a manual replacement reversal endpoint", async () => {
        const route = await createManualReplacementDeleteRoute();

        expect(route.routeExists).toBe(true);
        if (!route.routeExists) return;

        await route.invoke({
            userId: "u1",
            params: { oldMachineId: "m1" },
        });

        expect(txDbMocks.db.machine.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_id: { accountId: "u1", id: "m1" } },
            data: expect.objectContaining({
                replacedByMachineId: null,
                replacedAt: null,
                replacementReason: null,
                replacementSource: null,
                replacementActorUserId: null,
            }),
        }));
    });
});
