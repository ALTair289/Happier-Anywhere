import { MMKV } from 'react-native-mmkv';
import {
    parseSessionRuntimeActivityProjectionFields,
    PrimaryTurnStatusV1Schema,
    SessionRuntimeActivityStateSchema,
    SessionRuntimeIssueV1Schema,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { selectMostRecentWarmCacheSessionIds } from './warmCacheAdapters';

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

var warmCacheStorage: MMKV | null = null;
let warmCacheAccountScope: string | null = null;

function getWarmCacheStorage(): MMKV {
    if (warmCacheStorage) return warmCacheStorage;
    const storageScope = isWebRuntime ? null : readStorageScopeFromEnv();
    warmCacheStorage = storageScope ? new MMKV({ id: scopedStorageId('default', storageScope) }) : new MMKV();
    return warmCacheStorage;
}

const SESSION_LIST_WARM_CACHE_PREFIX = 'session-list-warm-cache-v1';
const MACHINE_DISPLAY_WARM_CACHE_PREFIX = 'machine-display-warm-cache-v1';
const SESSION_LIST_PINNED_IDS_WARM_CACHE_PREFIX = 'session-list-pinned-ids-warm-cache-v1';

export const SessionListCacheEntryV1Schema = z.object({
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative().optional(),
    metadataVersion: z.number().int().nonnegative(),
    agentStateVersion: z.number().int().nonnegative(),
    updatedAt: z.number(),
    meaningfulActivityAt: z.number().nullable().optional(),
    createdAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    archivedAt: z.number().nullable(),
    lastViewedSessionSeq: z.number().int().nonnegative().nullable().optional(),
    pendingCount: z.number().int().nonnegative().optional(),
    pendingBlockedCount: z.number().int().nonnegative().optional(),
    pendingVersion: z.number().int().nonnegative().optional(),
    latestTurnId: z.string().min(1).nullable().optional(),
    latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
    latestTurnStatusObservedAt: z.number().int().nonnegative().nullable().optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    runtimeActivityState: SessionRuntimeActivityStateSchema.nullable().optional(),
    runtimeActivityActiveCount: z.number().int().nonnegative().nullable().optional(),
    runtimeActivityObservedAt: z.number().int().nonnegative().nullable().optional(),
    runtimeActivitySourceClass: z.never().optional(),
    runtimeActivityRevision: z.number().int().nonnegative().safe().nullable().optional(),
    rollbackEligibleTurnStarts: z.array(z.number().int().nonnegative()).nullable().optional(),
    latestReadyEventSeq: z.number().int().nonnegative().nullable().optional(),
    latestReadyEventAt: z.number().int().nonnegative().nullable().optional(),
    pendingRequestObservedAt: z.number().int().nonnegative().nullable().optional(),
    accessLevel: z.enum(['view', 'edit', 'admin']).optional(),
    canApprovePermissions: z.boolean().optional(),
    name: z.string().optional(),
    summaryText: z.string().nullable().optional(),
    path: z.string(),
    homeDir: z.string().nullable().optional(),
    host: z.string().nullable().optional(),
    machineId: z.string().nullable().optional(),
    flavor: z.string().nullable().optional(),
    directSessionV1: z.object({
        v: z.literal(1),
        providerId: z.string().optional(),
    }).nullable().optional(),
    hiddenSystemSession: z.boolean().optional(),
    hasPendingPermissionRequests: z.boolean().optional(),
    hasPendingUserActionRequests: z.boolean().optional(),
    hasUnreadMessages: z.boolean().optional(),
    // The unread entry fact is durable read state, not activity: a cold boot that
    // dropped it would re-derive a per-boot ordering key for the attention lane
    // instead of restoring the one the server materialized.
    unreadSince: z.number().int().nonnegative().nullable().optional(),
}).superRefine((entry, context) => {
    if (parseSessionRuntimeActivityProjectionFields(entry).kind === 'invalid') {
        context.addIssue({
            code: 'custom',
            message: 'Runtime Activity must be absent or a complete validated tuple',
        });
    }
});

export type SessionListCacheEntryV1 = z.infer<typeof SessionListCacheEntryV1Schema>;

export const MachineDisplayCacheEntryV1Schema = z.object({
    machineId: z.string().min(1),
    metadataVersion: z.number().int().nonnegative(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    revokedAt: z.number().nullable(),
    displayName: z.string().nullable().optional(),
    host: z.string().nullable().optional(),
    homeDir: z.string().nullable().optional(),
});

export type MachineDisplayCacheEntryV1 = z.infer<typeof MachineDisplayCacheEntryV1Schema>;

const SessionListCacheEntriesSchema = z.record(z.string(), SessionListCacheEntryV1Schema);
const MachineDisplayCacheEntriesSchema = z.record(z.string(), MachineDisplayCacheEntryV1Schema);

function capSessionListCacheEntries(
    entries: Record<string, SessionListCacheEntryV1>,
): Record<string, SessionListCacheEntryV1> {
    const selectedIds = selectMostRecentWarmCacheSessionIds(entries);
    if (!selectedIds) return entries;
    const capped: Record<string, SessionListCacheEntryV1> = {};
    for (const sessionId of selectedIds) {
        capped[sessionId] = entries[sessionId];
    }
    return capped;
}

/**
 * What a warm-cache key currently holds, as the record object the app last read from or
 * wrote to it. Boot hydration reads these bytes and a store immediately projects them
 * back into cache entries; without a persisted baseline that projection looks like new
 * information and is re-serialized and rewritten before first paint. Owning "what is on
 * disk" here also removes the divergent reconstructions of "previous entries" that the
 * stores used to derive from their own renderables.
 *
 * One mechanism, one instance per cache: the session list and the machine displays hold
 * different entry shapes but share this baseline, so neither domain can drift into its
 * own answer for what the key already contains.
 */
function createPersistedWarmCacheBaseline<TEntry>(): Readonly<{
    read: (key: string | null) => Record<string, TEntry> | undefined;
    remember: (key: string, entries: Record<string, TEntry>) => void;
    forget: (key: string) => void;
}> {
    const entriesByKey = new Map<string, Record<string, TEntry>>();
    return {
        read: (key) => (key ? entriesByKey.get(key) : undefined),
        remember: (key, entries) => {
            entriesByKey.set(key, entries);
        },
        forget: (key) => {
            entriesByKey.delete(key);
        },
    };
}

const persistedSessionListBaseline = createPersistedWarmCacheBaseline<SessionListCacheEntryV1>();
const persistedMachineDisplayBaseline = createPersistedWarmCacheBaseline<MachineDisplayCacheEntryV1>();

function normalizeScopePart(value: string | null | undefined): string {
    const normalized = String(value ?? '').trim();
    return normalized;
}

export function setWarmCacheAccountScope(accountId: string | null | undefined): void {
    warmCacheAccountScope = normalizeScopePart(accountId) || null;
}

export function clearWarmCacheAccountScope(): void {
    warmCacheAccountScope = null;
}

export function resolveWarmCacheAccountScope(accountId: string | null | undefined): string | null {
    return warmCacheAccountScope ?? (normalizeScopePart(accountId) || null);
}

function buildScopedKey(prefix: string, serverId: string | null | undefined, accountId: string | null | undefined): string | null {
    const normalizedServerId = normalizeScopePart(serverId);
    const normalizedAccountId = normalizeScopePart(accountId);
    if (!normalizedServerId || !normalizedAccountId) return null;
    return `${prefix}:${normalizedServerId}:${normalizedAccountId}`;
}

function loadScopedRecord<T>(
    key: string | null,
    schema: z.ZodType<T>,
): T | null {
    if (!key) return null;
    const storage = getWarmCacheStorage();
    const raw = storage.getString(key);
    if (!raw) return null;

    try {
        const parsedJson = JSON.parse(raw);
        const parsed = schema.safeParse(parsedJson);
        if (!parsed.success) {
            storage.delete(key);
            return null;
        }
        return parsed.data;
    } catch {
        storage.delete(key);
        return null;
    }
}

function saveScopedRecord<T extends Record<string, unknown>>(key: string | null, value: T): void {
    if (!key) return;
    const storage = getWarmCacheStorage();
    if (Object.keys(value).length === 0) {
        storage.delete(key);
        return;
    }
    storage.set(key, JSON.stringify(value));
}

export function loadSessionListWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, SessionListCacheEntryV1> {
    const key = buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId);
    const loaded = loadScopedRecord(key, SessionListCacheEntriesSchema);
    if (!key) return loaded ?? {};
    if (!loaded) {
        persistedSessionListBaseline.forget(key);
        return {};
    }
    // The baseline is what the KEY holds, not what we hand back. When a pre-cap blob is
    // trimmed here, that difference is exactly what makes the next save rewrite the key
    // at its bounded size instead of leaving the oversized blob to be reparsed forever.
    persistedSessionListBaseline.remember(key, loaded);
    return capSessionListCacheEntries(loaded);
}

/**
 * The record the warm-cache key is currently known to hold, or `undefined` when this
 * scope has not been read or written in this process. Callers diff against it instead
 * of reconstructing a "previous entries" projection of their own.
 */
export function readPersistedSessionListWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
): Record<string, SessionListCacheEntryV1> | undefined {
    return persistedSessionListBaseline.read(buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId));
}

export function saveSessionListWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, SessionListCacheEntryV1>,
): void {
    const key = buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId);
    if (!key) return;
    if (persistedSessionListBaseline.read(key) === entries) return;
    saveScopedRecord(key, entries);
    if (Object.keys(entries).length === 0) {
        persistedSessionListBaseline.forget(key);
        return;
    }
    persistedSessionListBaseline.remember(key, entries);
}

const SessionListPinnedSessionIdsSchema = z.object({
    pinnedSessionIds: z.array(z.string().min(1)),
});

/**
 * Pinned rows must be hydrated with the first session-list page, and the request carries
 * the pinned ids so the server can merge those rows into it. Persisting the id *set*
 * (not merely the organization snapshot version) is what lets a cold boot issue that
 * request immediately instead of blocking the whole list behind the organization
 * snapshot round trip; persisting only the version would silently drop pinned hydration
 * on the first boot after install or cache eviction.
 */
export function loadSessionListPinnedSessionIdsWarmCache(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
): readonly string[] {
    const record = loadScopedRecord(
        buildScopedKey(SESSION_LIST_PINNED_IDS_WARM_CACHE_PREFIX, serverId, accountId),
        SessionListPinnedSessionIdsSchema,
    );
    return record?.pinnedSessionIds ?? [];
}

export function saveSessionListPinnedSessionIdsWarmCache(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    pinnedSessionIds: readonly string[],
): void {
    const key = buildScopedKey(SESSION_LIST_PINNED_IDS_WARM_CACHE_PREFIX, serverId, accountId);
    if (!key) return;
    const storage = getWarmCacheStorage();
    if (pinnedSessionIds.length === 0) {
        storage.delete(key);
        return;
    }
    const serialized = JSON.stringify({ pinnedSessionIds: [...pinnedSessionIds] });
    if (storage.getString(key) === serialized) return;
    storage.set(key, serialized);
}

export function loadMachineDisplayWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, MachineDisplayCacheEntryV1> {
    const key = buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId);
    const loaded = loadScopedRecord(key, MachineDisplayCacheEntriesSchema);
    if (!key) return loaded ?? {};
    if (!loaded) {
        persistedMachineDisplayBaseline.forget(key);
        return {};
    }
    persistedMachineDisplayBaseline.remember(key, loaded);
    return loaded;
}

/**
 * The record the machine-display warm-cache key is currently known to hold, or
 * `undefined` when this scope has not been read or written in this process.
 */
export function readPersistedMachineDisplayWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
): Record<string, MachineDisplayCacheEntryV1> | undefined {
    return persistedMachineDisplayBaseline.read(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId));
}

export function saveMachineDisplayWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, MachineDisplayCacheEntryV1>,
): void {
    const key = buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId);
    if (!key) return;
    if (persistedMachineDisplayBaseline.read(key) === entries) return;
    saveScopedRecord(key, entries);
    if (Object.keys(entries).length === 0) {
        persistedMachineDisplayBaseline.forget(key);
        return;
    }
    persistedMachineDisplayBaseline.remember(key, entries);
}
