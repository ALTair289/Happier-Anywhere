import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applySqliteMigrations } from "./prismaMigrations";

type NodeSqliteDatabase = Readonly<{
    exec: (sql: string) => void;
    prepare: (sql: string) => Readonly<{
        get: (...params: unknown[]) => unknown;
    }>;
    close: () => void;
}>;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => NodeSqliteDatabase;
};

describe("applySqliteMigrations", () => {
    it("delegates unsafe partial legacy recovery to the canonical SQLite policy owner", async () => {
        const migrationsDir = await mkdtemp(join(tmpdir(), "happier-node-sqlite-migrations-"));
        const databaseDir = await mkdtemp(join(tmpdir(), "happier-node-sqlite-data-"));
        try {
            const migrationName = "20260101000000_partial";
            const migrationDir = join(migrationsDir, migrationName);
            await mkdir(migrationDir, { recursive: true });
            await writeFile(
                join(migrationDir, "migration.sql"),
                "CREATE TABLE Account(id INTEGER);\nCREATE TABLE IF NOT EXISTS Widget(id INTEGER);\n",
                "utf8",
            );

            const databasePath = join(databaseDir, "happier.sqlite");
            const seed = new DatabaseSync(databasePath);
            seed.exec("CREATE TABLE Account(id INTEGER);");
            seed.close();

            await expect(applySqliteMigrations({ databasePath, migrationsDir })).rejects.toThrow(
                /cannot be marked applied safely/i,
            );

            const inspect = new DatabaseSync(databasePath);
            try {
                expect(
                    inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Widget'").get(),
                ).toBeUndefined();
                expect(
                    inspect.prepare(
                        "SELECT migration_name FROM _prisma_migrations WHERE migration_name = ?",
                    ).get(migrationName),
                ).toBeUndefined();
            } finally {
                inspect.close();
            }
        } finally {
            await Promise.all([
                rm(migrationsDir, { recursive: true, force: true }),
                rm(databaseDir, { recursive: true, force: true }),
            ]);
        }
    });
});
