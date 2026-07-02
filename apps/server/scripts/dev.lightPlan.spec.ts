import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLightDevPlan, recordLightDevMigrationSignature } from "./dev.lightPlan";

async function writeMigrationFixture(sql: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "happier-dev-light-plan-migrations-"));
    const migrationDir = join(dir, "20260101000000_test");
    await mkdir(migrationDir, { recursive: true });
    await writeFile(join(migrationDir, "migration.sql"), sql, "utf8");
    return dir;
}

async function createEnv(overrides: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
    const dataDir = await mkdtemp(join(tmpdir(), "happier-dev-light-plan-data-"));
    const migrationsDir = await writeMigrationFixture("CREATE TABLE Test(id INTEGER);\n");
    return {
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
        HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
        HAPPIER_SERVER_LIGHT_DB_DIR: join(dataDir, "pglite"),
        HAPPY_SERVER_LIGHT_DB_DIR: join(dataDir, "pglite"),
        HAPPIER_SQLITE_MIGRATIONS_DIR: migrationsDir,
        DATABASE_URL: `file:${join(dataDir, "happier.sqlite")}`,
        ...overrides,
    };
}

describe('buildLightDevPlan', () => {
    it('uses migrate:sqlite:deploy as the default migration step', () => {
        const plan = buildLightDevPlan({});
        expect(plan.migrateDeployArgs).toEqual(['-s', 'migrate:sqlite:deploy']);
        expect(plan.startLightArgs).toEqual(['-s', 'start:light']);
    });

    it('uses migrate:sqlite:deploy when HAPPY_DB_PROVIDER=sqlite', () => {
        const plan = buildLightDevPlan({ HAPPY_DB_PROVIDER: 'sqlite' });
        expect(plan.migrateDeployArgs).toEqual(['-s', 'migrate:sqlite:deploy']);
    });

    it("skips migrate deploy in auto mode when the migration signature matches", async () => {
        const env = await createEnv();
        const firstPlan = buildLightDevPlan(env);
        expect(firstPlan.shouldRunMigrateDeploy).toBe(true);
        expect(firstPlan.migrationsChanged).toBe(true);

        await recordLightDevMigrationSignature(firstPlan);

        const secondPlan = buildLightDevPlan(env);
        expect(secondPlan.shouldRunMigrateDeploy).toBe(false);
        expect(secondPlan.migrateDeployArgs).toBeNull();
        expect(secondPlan.migrationsChanged).toBe(false);
        expect(secondPlan.migrationSignature).toEqual(firstPlan.migrationSignature);
    });

    it("runs migrate deploy when migration contents change", async () => {
        const env = await createEnv();
        const firstPlan = buildLightDevPlan(env);
        await recordLightDevMigrationSignature(firstPlan);

        await writeFile(
            join(env.HAPPIER_SQLITE_MIGRATIONS_DIR!, "20260101000000_test", "migration.sql"),
            "CREATE TABLE Test(id INTEGER);\nCREATE TABLE Other(id INTEGER);\n",
            "utf8",
        );

        const changedPlan = buildLightDevPlan(env);
        expect(changedPlan.shouldRunMigrateDeploy).toBe(true);
        expect(changedPlan.migrationsChanged).toBe(true);
        expect(changedPlan.migrateDeployArgs).toEqual(['-s', 'migrate:sqlite:deploy']);
    });

    it("runs migrate deploy instead of throwing when a migration input file cannot be read", async () => {
        const env = await createEnv();
        const firstPlan = buildLightDevPlan(env);
        await recordLightDevMigrationSignature(firstPlan);

        const migrationFile = join(env.HAPPIER_SQLITE_MIGRATIONS_DIR!, "20260101000000_test", "migration.sql");
        await chmod(migrationFile, 0o000);
        try {
            const changedPlan = buildLightDevPlan(env);

            expect(changedPlan.shouldRunMigrateDeploy).toBe(true);
            expect(changedPlan.migrationsChanged).toBe(true);
            expect(changedPlan.migrateDeployArgs).toEqual(['-s', 'migrate:sqlite:deploy']);
        } finally {
            await chmod(migrationFile, 0o600).catch(() => {});
        }
    });

    it("does not treat unavailable migration inputs as a cache hit", async () => {
        const env = await createEnv({
            HAPPIER_SQLITE_MIGRATIONS_DIR: join(await mkdtemp(join(tmpdir(), "happier-dev-light-plan-missing-parent-")), "missing"),
        });

        const firstPlan = buildLightDevPlan(env);
        expect(firstPlan.shouldRunMigrateDeploy).toBe(true);
        expect(firstPlan.migrationsChanged).toBe(true);
        await recordLightDevMigrationSignature(firstPlan);

        const secondPlan = buildLightDevPlan(env);
        expect(secondPlan.shouldRunMigrateDeploy).toBe(true);
        expect(secondPlan.migrationsChanged).toBe(true);
        expect(secondPlan.migrateDeployArgs).toEqual(['-s', 'migrate:sqlite:deploy']);
    });

    it("runs migrate deploy when provider or DB identity changes", async () => {
        const env = await createEnv();
        const firstPlan = buildLightDevPlan(env);
        await recordLightDevMigrationSignature(firstPlan);

        const pglitePlan = buildLightDevPlan({ ...env, HAPPY_DB_PROVIDER: "pglite", HAPPIER_DB_PROVIDER: "pglite" });
        expect(pglitePlan.shouldRunMigrateDeploy).toBe(true);
        expect(pglitePlan.migrationsChanged).toBe(true);
        expect(pglitePlan.migrateDeployArgs).toEqual(['-s', 'migrate:light:deploy']);

        const otherDataDir = await mkdtemp(join(tmpdir(), "happier-dev-light-plan-other-data-"));
        const otherDbPlan = buildLightDevPlan({
            ...env,
            HAPPIER_SERVER_LIGHT_DATA_DIR: otherDataDir,
            HAPPY_SERVER_LIGHT_DATA_DIR: otherDataDir,
            DATABASE_URL: `file:${join(otherDataDir, "happier.sqlite")}`,
        });
        expect(otherDbPlan.shouldRunMigrateDeploy).toBe(true);
        expect(otherDbPlan.migrationsChanged).toBe(true);
    });

    it("honors always and skip migrate modes while preserving the migration-changed signal", async () => {
        const env = await createEnv();
        const firstPlan = buildLightDevPlan(env);
        await recordLightDevMigrationSignature(firstPlan);

        const alwaysPlan = buildLightDevPlan({ ...env, HAPPIER_STACK_MIGRATE_MODE: "always" });
        expect(alwaysPlan.shouldRunMigrateDeploy).toBe(true);
        expect(alwaysPlan.migrationsChanged).toBe(true);
        expect(alwaysPlan.migrateDeployArgs).toEqual(['-s', 'migrate:sqlite:deploy']);

        const skipPlan = buildLightDevPlan({ ...env, HAPPIER_STACK_MIGRATE_MODE: "skip" });
        expect(skipPlan.shouldRunMigrateDeploy).toBe(false);
        expect(skipPlan.migrationsChanged).toBe(false);
        expect(skipPlan.migrateDeployArgs).toBeNull();

        await writeFile(
            join(env.HAPPIER_SQLITE_MIGRATIONS_DIR!, "20260101000000_test", "migration.sql"),
            "CREATE TABLE Test(id INTEGER);\nCREATE TABLE Changed(id INTEGER);\n",
            "utf8",
        );

        const changedSkipPlan = buildLightDevPlan({ ...env, HAPPIER_STACK_MIGRATE_MODE: "skip" });
        expect(changedSkipPlan.shouldRunMigrateDeploy).toBe(false);
        expect(changedSkipPlan.migrationsChanged).toBe(true);
        expect(changedSkipPlan.migrateDeployArgs).toBeNull();
    });
});
