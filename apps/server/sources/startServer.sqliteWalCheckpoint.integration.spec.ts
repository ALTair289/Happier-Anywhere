import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
    createStartServerDbMocks,
    installStartServerDbModuleMock,
    installStartServerCommonWiringMocks,
} from "@/testkit/startServerMocks";
import { createStartServerHarness } from "@/testkit/startServerHarness";

const sqliteWalCheckpointMocks = vi.hoisted(() => {
    const stop = vi.fn(async () => {});
    const stopVacuum = vi.fn(async () => {});
    return {
        resolveBusyTimeout: vi.fn(() => 5000),
        resolveInterval: vi.fn(() => 1000),
        resolveVacuumInterval: vi.fn(() => 6 * 60 * 60 * 1000),
        resolveVacuumPages: vi.fn(() => 1000),
        startWorker: vi.fn(() => ({ stop })),
        startVacuumWorker: vi.fn(() => ({ stop: stopVacuum })),
        stop,
        stopVacuum,
    };
});

const callOrder: string[] = [];

const dbDisconnect = vi.fn(async () => {
    callOrder.push("db.$disconnect");
});

const startServerDbMocks = createStartServerDbMocks({
    getDbProviderFromEnv: () => "sqlite",
});
startServerDbMocks.dbDisconnect.mockImplementation(dbDisconnect);

installStartServerDbModuleMock(startServerDbMocks);

installStartServerCommonWiringMocks();

vi.mock("@/storage/sqliteWalCheckpoint", () => ({
    resolveSqliteIncrementalVacuumIntervalMsFromEnv: sqliteWalCheckpointMocks.resolveVacuumInterval,
    resolveSqliteIncrementalVacuumPagesFromEnv: sqliteWalCheckpointMocks.resolveVacuumPages,
    resolveSqliteWalCheckpointBusyTimeoutMsFromEnv: sqliteWalCheckpointMocks.resolveBusyTimeout,
    resolveSqliteWalCheckpointIntervalMsFromEnv: sqliteWalCheckpointMocks.resolveInterval,
    startSqliteIncrementalVacuumWorker: sqliteWalCheckpointMocks.startVacuumWorker,
    startSqliteWalCheckpointWorker: sqliteWalCheckpointMocks.startWorker,
}));

// Avoid hanging in tests: startServer calls awaitShutdown().
vi.mock("@/utils/process/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/process/shutdown");
    return { ...actual, awaitShutdown: vi.fn(async () => {}) };
});

describe("startServer sqlite WAL checkpoint shutdown ordering", () => {
    const startServerHarness = createStartServerHarness();
    const originalDbSizeWarnBytes = process.env.HAPPIER_SERVER_DB_SIZE_WARN_BYTES;

    beforeEach(() => {
        callOrder.length = 0;
        startServerDbMocks.reset();
        startServerDbMocks.dbDisconnect.mockImplementation(dbDisconnect);
        startServerDbMocks.sqliteMaintenanceClientDisconnect.mockImplementation(async () => {
            callOrder.push("sqliteMaintenanceClient.$disconnect");
        });
        sqliteWalCheckpointMocks.resolveBusyTimeout.mockReset().mockReturnValue(5000);
        sqliteWalCheckpointMocks.resolveInterval.mockReset().mockReturnValue(1000);
        sqliteWalCheckpointMocks.resolveVacuumInterval.mockReset().mockReturnValue(6 * 60 * 60 * 1000);
        sqliteWalCheckpointMocks.resolveVacuumPages.mockReset().mockReturnValue(1000);
        sqliteWalCheckpointMocks.startWorker
            .mockReset()
            .mockImplementation(() => ({ stop: sqliteWalCheckpointMocks.stop }));
        sqliteWalCheckpointMocks.startVacuumWorker
            .mockReset()
            .mockImplementation(() => ({ stop: sqliteWalCheckpointMocks.stopVacuum }));
        sqliteWalCheckpointMocks.stop.mockReset().mockImplementation(async () => {
            callOrder.push("sqliteWalCheckpoint.stop");
        });
        sqliteWalCheckpointMocks.stopVacuum.mockReset().mockImplementation(async () => {
            callOrder.push("sqliteIncrementalVacuum.stop");
        });
        startServerHarness.reset();
    });

    afterEach(() => {
        startServerHarness.restore();
        if (originalDbSizeWarnBytes === undefined) {
            delete process.env.HAPPIER_SERVER_DB_SIZE_WARN_BYTES;
        } else {
            process.env.HAPPIER_SERVER_DB_SIZE_WARN_BYTES = originalDbSizeWarnBytes;
        }
    });

    it("stops the sqlite WAL checkpoint worker before disconnecting Prisma", async () => {
        startServerHarness.prepareImport({
            SERVER_ROLE: "api",
            REDIS_URL: undefined,
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_PROVIDER: "sqlite",
            DATABASE_URL: "file:/tmp/happier-start-server-sqlite-shutdown-order.sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
            HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
        });

        const { startServer } = await import("./startServer");
        const { initiateShutdown } = await import("@/utils/process/shutdown");

        await startServer("light");
        await initiateShutdown("test");

        expect(sqliteWalCheckpointMocks.startWorker).toHaveBeenCalledTimes(1);
        expect(sqliteWalCheckpointMocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({
            client: startServerDbMocks.sqliteMaintenanceClient,
        }));
        expect(sqliteWalCheckpointMocks.startVacuumWorker).toHaveBeenCalledTimes(1);
        expect(sqliteWalCheckpointMocks.startVacuumWorker).toHaveBeenCalledWith(expect.objectContaining({
            client: startServerDbMocks.sqliteMaintenanceClient,
            intervalMs: 6 * 60 * 60 * 1000,
            pages: 1000,
        }));
        expect(startServerDbMocks.applySqliteRuntimePragmas).toHaveBeenCalledWith(
            startServerDbMocks.sqliteMaintenanceClient,
            expect.objectContaining({
                HAPPIER_SQLITE_BUSY_TIMEOUT_MS: "5000",
                HAPPY_SQLITE_BUSY_TIMEOUT_MS: "5000",
            }),
        );
        expect(callOrder).toEqual([
            "sqliteWalCheckpoint.stop",
            "sqliteIncrementalVacuum.stop",
            "sqliteMaintenanceClient.$disconnect",
            "db.$disconnect",
        ]);
    });

    it("does not open a sqlite maintenance client when SQLite maintenance is disabled", async () => {
        sqliteWalCheckpointMocks.resolveInterval.mockReturnValue(0);
        sqliteWalCheckpointMocks.resolveVacuumInterval.mockReturnValue(0);
        startServerHarness.prepareImport({
            SERVER_ROLE: "api",
            REDIS_URL: undefined,
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_PROVIDER: "sqlite",
            DATABASE_URL: "file:/tmp/happier-start-server-sqlite-shutdown-disabled.sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
            HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
        });

        const { startServer } = await import("./startServer");
        const { initiateShutdown } = await import("@/utils/process/shutdown");

        await startServer("light");
        await initiateShutdown("test");

        expect(startServerDbMocks.createDbSqliteMaintenanceClient).not.toHaveBeenCalled();
        expect(sqliteWalCheckpointMocks.resolveBusyTimeout).not.toHaveBeenCalled();
        expect(sqliteWalCheckpointMocks.resolveVacuumPages).not.toHaveBeenCalled();
        expect(sqliteWalCheckpointMocks.startWorker).not.toHaveBeenCalled();
        expect(sqliteWalCheckpointMocks.startVacuumWorker).not.toHaveBeenCalled();
        expect(callOrder).toEqual(["db.$disconnect"]);
    });

    it("warns when the sqlite database file exceeds the configured boot threshold", async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), "happier-sqlite-size-"));
        try {
            const dbPath = join(tmpDir, "happier.sqlite");
            await writeFile(dbPath, "12345", "utf8");
            startServerHarness.prepareImport({
                SERVER_ROLE: "api",
                REDIS_URL: undefined,
                HAPPY_DB_PROVIDER: "sqlite",
                HAPPIER_DB_PROVIDER: "sqlite",
                HAPPIER_SERVER_DB_SIZE_WARN_BYTES: "4",
                DATABASE_URL: `file:${dbPath}`,
                HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
                HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
            });

            const { startServer } = await import("./startServer");
            const { log } = await import("@/utils/logging/log");

            await startServer("light");

            expect(log).toHaveBeenCalledWith(
                expect.objectContaining({
                    module: "sqlite",
                    level: "warn",
                    path: dbPath,
                    sizeBytes: 5,
                    thresholdBytes: 4,
                }),
                expect.stringContaining("SQLite database file is larger than the configured warning threshold"),
            );
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it("warns when the sqlite WAL file exceeds the configured boot threshold", async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), "happier-sqlite-wal-size-"));
        try {
            const dbPath = join(tmpDir, "happier.sqlite");
            await writeFile(dbPath, "1", "utf8");
            await writeFile(`${dbPath}-wal`, "12345", "utf8");
            startServerHarness.prepareImport({
                SERVER_ROLE: "api",
                REDIS_URL: undefined,
                HAPPY_DB_PROVIDER: "sqlite",
                HAPPIER_DB_PROVIDER: "sqlite",
                HAPPIER_SERVER_DB_SIZE_WARN_BYTES: "4",
                DATABASE_URL: `file:${dbPath}`,
                HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
                HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
            });

            const { startServer } = await import("./startServer");
            const { log } = await import("@/utils/logging/log");

            await startServer("light");

            expect(log).toHaveBeenCalledWith(
                expect.objectContaining({
                    module: "sqlite",
                    level: "warn",
                    path: `${dbPath}-wal`,
                    sizeBytes: 5,
                    thresholdBytes: 4,
                }),
                expect.stringContaining("SQLite WAL file is larger than the configured warning threshold"),
            );
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it("does not inspect sqlite size thresholds for non-sqlite providers", async () => {
        startServerHarness.prepareImport({
            SERVER_ROLE: "api",
            REDIS_URL: undefined,
            HAPPY_DB_PROVIDER: "pglite",
            HAPPIER_DB_PROVIDER: "pglite",
            HAPPIER_SERVER_DB_SIZE_WARN_BYTES: "1",
        });
        startServerDbMocks.getDbProviderFromEnv.mockReturnValue("pglite");

        const { startServer } = await import("./startServer");
        const { log } = await import("@/utils/logging/log");

        await startServer("light");

        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "sqlite", level: "warn" }),
            expect.any(String),
        );
    });
});
