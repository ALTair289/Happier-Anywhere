import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLightSqliteDatabaseUrl } from "../sources/flavors/light/env";
import { resolveSqliteDatabaseFilePath } from "../sources/flavors/light/sqliteMigrations";
import { getDbProviderFromEnv } from "../sources/storage/prisma";

type LightDbProvider = "sqlite" | "pglite";
type LightMigrateMode = "always" | "auto" | "skip";

export type LightMigrationSignature = Readonly<{
    provider: LightDbProvider;
    inputsHash: string;
    dbIdentity: string;
}>;

export type LightDevPlan = {
    provider: LightDbProvider;
    migrateMode: LightMigrateMode;
    migrateDeployArgs: string[] | null;
    shouldRunMigrateDeploy: boolean;
    startLightArgs: string[];
    migrationSignature: LightMigrationSignature;
    migrationSignatureCachePath: string;
    migrationInputsReliable: boolean;
    migrationsChanged: boolean;
};

const SIGNATURE_CACHE_FILENAME = ".happier-light-migration-signature.json";

function serverRootDir(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function firstNonEmpty(...values: Array<string | undefined>): string {
    for (const value of values) {
        const trimmed = String(value ?? "").trim();
        if (trimmed) return trimmed;
    }
    return "";
}

function sha256Hex(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

function hashReadableFileEntry(resolvedPath: string): { entry: string; reliable: boolean } {
    try {
        return {
            entry: `${relative(serverRootDir(), resolvedPath)}\0file\0${sha256Hex(readFileSync(resolvedPath, "utf8"))}`,
            reliable: true,
        };
    } catch {
        return { entry: `${resolvedPath}\0unreadable`, reliable: false };
    }
}

function resolveMigrateMode(env: NodeJS.ProcessEnv): LightMigrateMode {
    const raw = firstNonEmpty(env.HAPPIER_STACK_MIGRATE_MODE).toLowerCase();
    if (raw === "always" || raw === "skip") return raw;
    return "auto";
}

function hashPathInto(path: string, entries: string[]): boolean {
    const resolved = resolve(path);
    let stat;
    try {
        stat = lstatSync(resolved);
    } catch {
        entries.push(`${resolved}\0missing`);
        return false;
    }

    if (stat.isFile()) {
        const result = hashReadableFileEntry(resolved);
        entries.push(result.entry);
        return result.reliable;
    }
    if (!stat.isDirectory()) {
        entries.push(`${resolved}\0other`);
        return false;
    }

    let statEntries;
    try {
        statEntries = readdirSync(resolved, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        entries.push(`${resolved}\0unreadable`);
        return false;
    }
    let reliable = true;
    for (const entry of statEntries) {
        const childPath = join(resolved, entry.name);
        if (entry.isDirectory()) {
            reliable = hashPathInto(childPath, entries) && reliable;
        } else if (entry.isFile()) {
            const result = hashReadableFileEntry(resolve(childPath));
            entries.push(result.entry);
            reliable = result.reliable && reliable;
        }
    }
    return reliable;
}

function hashFileInto(path: string, entries: string[]): boolean {
    const resolved = resolve(path);
    try {
        const stat = lstatSync(resolved);
        if (!stat.isFile()) {
            entries.push(`${resolved}\0not-file`);
            return false;
        }
    } catch {
        entries.push(`${resolved}\0missing`);
        return false;
    }
    const result = hashReadableFileEntry(resolved);
    entries.push(result.entry);
    return result.reliable;
}

function resolveMigrationInputs(provider: LightDbProvider, env: NodeJS.ProcessEnv): Readonly<{
    hash: string;
    reliable: boolean;
}> {
    const root = serverRootDir();
    const migrationsDir = provider === "sqlite"
        ? firstNonEmpty(env.HAPPIER_SQLITE_MIGRATIONS_DIR, env.HAPPY_SQLITE_MIGRATIONS_DIR) || join(root, "prisma", "sqlite", "migrations")
        : join(root, "prisma", "migrations");
    const schemaPath = provider === "sqlite"
        ? join(root, "prisma", "sqlite", "schema.prisma")
        : join(root, "prisma", "schema.prisma");

    const entries: string[] = [];
    const migrationsReliable = hashPathInto(migrationsDir, entries);
    const schemaReliable = hashFileInto(schemaPath, entries);
    return {
        hash: sha256Hex(entries.sort().join("\n")),
        reliable: migrationsReliable && schemaReliable,
    };
}

function resolveSqliteDbIdentity(env: NodeJS.ProcessEnv): string {
    const databaseUrl = firstNonEmpty(env.DATABASE_URL) || (() => {
        const dataDir = firstNonEmpty(env.HAPPIER_SERVER_LIGHT_DATA_DIR, env.HAPPY_SERVER_LIGHT_DATA_DIR);
        return dataDir ? resolveLightSqliteDatabaseUrl(dataDir) : "";
    })();
    const dbPath = resolveSqliteDatabaseFilePath(databaseUrl);
    return dbPath ? resolve(dbPath) : databaseUrl;
}

function resolvePgliteDbIdentity(env: NodeJS.ProcessEnv): string {
    return resolve(firstNonEmpty(env.HAPPIER_SERVER_LIGHT_DB_DIR, env.HAPPY_SERVER_LIGHT_DB_DIR));
}

function resolveDbIdentity(provider: LightDbProvider, env: NodeJS.ProcessEnv): string {
    return provider === "sqlite" ? resolveSqliteDbIdentity(env) : resolvePgliteDbIdentity(env);
}

function resolveSignatureCachePath(provider: LightDbProvider, env: NodeJS.ProcessEnv): string {
    if (provider === "sqlite") {
        const dbIdentity = resolveSqliteDbIdentity(env);
        return join(dirname(dbIdentity || resolve(firstNonEmpty(env.HAPPIER_SERVER_LIGHT_DATA_DIR, env.HAPPY_SERVER_LIGHT_DATA_DIR) || ".")), SIGNATURE_CACHE_FILENAME);
    }
    const dbDir = resolvePgliteDbIdentity(env);
    return join(dirname(dbDir || resolve(firstNonEmpty(env.HAPPIER_SERVER_LIGHT_DATA_DIR, env.HAPPY_SERVER_LIGHT_DATA_DIR) || ".")), SIGNATURE_CACHE_FILENAME);
}

function readCachedSignature(cachePath: string): LightMigrationSignature | null {
    try {
        const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
        if (!parsed || typeof parsed !== "object") return null;
        const provider = parsed.provider === "sqlite" || parsed.provider === "pglite" ? parsed.provider : null;
        const inputsHash = typeof parsed.inputsHash === "string" ? parsed.inputsHash : "";
        const dbIdentity = typeof parsed.dbIdentity === "string" ? parsed.dbIdentity : "";
        if (!provider || !inputsHash || !dbIdentity) return null;
        return { provider, inputsHash, dbIdentity };
    } catch {
        return null;
    }
}

function signaturesEqual(a: LightMigrationSignature | null, b: LightMigrationSignature): boolean {
    return a?.provider === b.provider && a.inputsHash === b.inputsHash && a.dbIdentity === b.dbIdentity;
}

export async function recordLightDevMigrationSignature(plan: LightDevPlan): Promise<void> {
    mkdirSync(dirname(plan.migrationSignatureCachePath), { recursive: true });
    writeFileSync(plan.migrationSignatureCachePath, JSON.stringify(plan.migrationSignature, null, 2) + "\n", "utf8");
}

export function buildLightDevPlan(env: NodeJS.ProcessEnv): LightDevPlan {
    const provider = getDbProviderFromEnv(env, "sqlite");
    if (provider !== "pglite" && provider !== "sqlite") {
        throw new Error(`Unsupported HAPPY_DB_PROVIDER/HAPPIER_DB_PROVIDER for light dev plan: ${provider}`);
    }

    const migrateMode = resolveMigrateMode(env);
    const migrationInputs = resolveMigrationInputs(provider, env);
    const migrationSignature = {
        provider,
        inputsHash: migrationInputs.hash,
        dbIdentity: resolveDbIdentity(provider, env),
    };
    const migrationSignatureCachePath = resolveSignatureCachePath(provider, env);
    const cachedSignature = readCachedSignature(migrationSignatureCachePath);
    const signatureMatches = signaturesEqual(cachedSignature, migrationSignature);
    const shouldRunMigrateDeploy = migrateMode === "always" || (migrateMode === "auto" && (!signatureMatches || !migrationInputs.reliable));
    const migrationsChanged = migrateMode === "always" || !signatureMatches || !migrationInputs.reliable;

    return {
        provider,
        migrateMode,
        migrateDeployArgs: shouldRunMigrateDeploy
            ? ["-s", provider === "sqlite" ? "migrate:sqlite:deploy" : "migrate:light:deploy"]
            : null,
        shouldRunMigrateDeploy,
        startLightArgs: ["-s", "start:light"],
        migrationSignature,
        migrationSignatureCachePath,
        migrationInputsReliable: migrationInputs.reliable,
        migrationsChanged,
    };
}
