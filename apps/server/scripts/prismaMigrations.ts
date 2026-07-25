import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import {
    applySqliteMigrations as applySqliteMigrationsWithExecutor,
    type SqliteMigrationExecutor,
} from "../sources/flavors/light/sqliteMigrations";

type NodeSqliteStatement = Readonly<{
    all: () => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => unknown;
}>;

type NodeSqliteDatabase = Readonly<{
    exec: (sql: string) => void;
    prepare: (sql: string) => NodeSqliteStatement;
    close: () => void;
}>;

type CloseableSqliteMigrationExecutor = SqliteMigrationExecutor & Readonly<{
    close: () => void;
}>;

const require = createRequire(import.meta.url);

function createNodeSqliteExecutor(params: Readonly<{
    databasePath: string;
    busyTimeoutMs: number;
}>): CloseableSqliteMigrationExecutor {
    const { DatabaseSync } = require("node:sqlite") as {
        DatabaseSync: new (path: string) => NodeSqliteDatabase;
    };
    const db = new DatabaseSync(params.databasePath);
    db.exec(`PRAGMA busy_timeout=${params.busyTimeoutMs};`);

    return Object.freeze({
        exec: (sql) => {
            db.exec(sql);
        },
        queryTableNames: () => {
            const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
            return new Set(
                rows
                    .map((row) => String((row as { name?: string }).name ?? "").trim())
                    .filter(Boolean),
            );
        },
        queryAppliedMigrations: () => {
            const rows = db
                .prepare(
                    "SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL",
                )
                .all();
            return rows.map((row) => ({
                name: String((row as { migration_name?: string }).migration_name ?? ""),
                checksum: String((row as { checksum?: string }).checksum ?? ""),
            }));
        },
        insertAppliedMigration: ({ name, checksum }) => {
            db.prepare(
                "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)",
            ).run(randomUUID(), checksum, name);
        },
        close: () => {
            db.close();
        },
    });
}

export async function applySqliteMigrations(params: Readonly<{
    databasePath: string;
    migrationsDir: string;
    busyTimeoutMs?: number;
}>): Promise<{ applied: string[] }> {
    await mkdir(dirname(params.databasePath), { recursive: true }).catch(() => {});
    const executor = createNodeSqliteExecutor({
        databasePath: params.databasePath,
        busyTimeoutMs: params.busyTimeoutMs ?? 0,
    });
    try {
        return await applySqliteMigrationsWithExecutor({
            executor,
            migrationsDir: params.migrationsDir,
        });
    } finally {
        executor.close();
    }
}
