import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function readText(path: string): string {
    return readFileSync(path, "utf-8");
}

function listMigrationSqlFiles(migrationsDir: string): string[] {
    const entries = readdirSync(migrationsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(migrationsDir, e.name, "migration.sql"));
    return entries;
}

function anyFileContains(paths: string[], patterns: string[]): boolean {
    for (const p of paths) {
        let text = "";
        try {
            text = readText(p);
        } catch {
            continue;
        }
        if (patterns.every((pat) => text.includes(pat))) {
            return true;
        }
    }
    return false;
}

function expectProviderSchemasToContain(root: string, expectedText: string): void {
    expect(readText(join(root, "prisma", "schema.prisma"))).toContain(expectedText);
    expect(readText(join(root, "prisma", "sqlite", "schema.prisma"))).toContain(expectedText);
    expect(readText(join(root, "prisma", "mysql", "schema.prisma"))).toContain(expectedText);
}

describe("migrations (provider completeness)", () => {
    it("includes AccountChange entity FK columns across providers", () => {
        const root = process.cwd();
        const schema = readText(join(root, "prisma", "schema.prisma"));
        expect(schema).toContain("sessionId");
        expect(schema).toContain("machineId");
        expect(schema).toContain("artifactId");

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "AccountChange" ADD COLUMN',
                '"sessionId"',
                '"machineId"',
                '"artifactId"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'CREATE TABLE "AccountChange"',
                '"sessionId"',
                '"machineId"',
                '"artifactId"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "CREATE TABLE `AccountChange`",
                "`sessionId`",
                "`machineId`",
                "`artifactId`",
            ]),
        ).toBe(true);
    });

    it("includes AccountPushToken.clientServerUrl across providers", () => {
        const root = process.cwd();
        expectProviderSchemasToContain(root, "clientServerUrl String?");

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "AccountPushToken" ADD COLUMN',
                '"clientServerUrl"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'ALTER TABLE "AccountPushToken" ADD COLUMN',
                '"clientServerUrl"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "ALTER TABLE `AccountPushToken` ADD COLUMN",
                "`clientServerUrl`",
            ]),
        ).toBe(true);
    });

    it("backfills Session.meaningfulActivityAt from pending rows across providers", () => {
        const root = process.cwd();

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "Session" ADD COLUMN "meaningfulActivityAt"',
                'FROM "SessionPendingMessage"',
                'MAX("createdAt")',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'ALTER TABLE "Session" ADD COLUMN "meaningfulActivityAt"',
                'FROM "SessionPendingMessage"',
                'MAX("createdAt")',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "ALTER TABLE `Session` ADD COLUMN `meaningfulActivityAt`",
                "FROM `SessionPendingMessage`",
                "MAX(`createdAt`)",
            ]),
        ).toBe(true);
    });

    it("includes session organization tables across providers", () => {
        const root = process.cwd();
        expectProviderSchemasToContain(root, "model SessionPin");
        expectProviderSchemasToContain(root, "model SessionOrganizationFolder");
        expectProviderSchemasToContain(root, "model SessionOrganizationTag");
        expectProviderSchemasToContain(root, "model SessionTagAssignment");
        expectProviderSchemasToContain(root, "model SessionOrganizationOrderEntry");
        expectProviderSchemasToContain(root, "model SessionOrganizationLabel");
        expectProviderSchemasToContain(root, "model SessionOrganizationCheckpoint");

        const tableNames = [
            "SessionPin",
            "SessionOrganizationFolder",
            "SessionOrganizationTag",
            "SessionTagAssignment",
            "SessionOrganizationOrderEntry",
            "SessionOrganizationLabel",
            "SessionOrganizationCheckpoint",
        ];

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        for (const tableName of tableNames) {
            expect(anyFileContains(pgFiles, [`CREATE TABLE "${tableName}"`])).toBe(true);
        }

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        for (const tableName of tableNames) {
            expect(anyFileContains(sqliteFiles, [`CREATE TABLE "${tableName}"`])).toBe(true);
        }

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        for (const tableName of tableNames) {
            expect(anyFileContains(mysqlFiles, [`CREATE TABLE \`${tableName}\``])).toBe(true);
        }
    });
});
