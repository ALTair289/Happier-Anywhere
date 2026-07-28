import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerAccountScope } from '../../scope/serverAccountScope';

const store = vi.hoisted(() => new Map<string, string>());
const writesByKey = vi.hoisted(() => new Map<string, number>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            writesByKey.set(key, (writesByKey.get(key) ?? 0) + 1);
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

type AgentInputDraftOwner =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'newSession'; flowId: string }>;

type AgentInputLocalUiStateStoreModule = Readonly<{
    agentInputDraftOwnerKey: (owner: AgentInputDraftOwner | null | undefined) => string | null;
    readAgentInputLocalUiState: (
        scope: ServerAccountScope | null | undefined,
        owner: AgentInputDraftOwner,
        options?: Readonly<{ textLength?: number; fontScale?: number }>,
    ) => Readonly<{
        v: 1;
        expanded?: boolean;
        scrollY?: number;
        selection?: Readonly<{ start: number; end: number }>;
        textLength?: number;
        fontScale?: number;
        updatedAt: number;
    }> | null;
    patchAgentInputLocalUiState: (
        scope: ServerAccountScope | null | undefined,
        owner: AgentInputDraftOwner,
        patch: Readonly<{
            expanded?: boolean;
            scrollY?: number;
            selection?: Readonly<{ start: number; end: number }>;
            textLength?: number;
            fontScale?: number;
        }>,
        options?: Readonly<{ now?: number; flush?: boolean }>,
    ) => void;
    clearAgentInputLocalUiState: (
        scope: ServerAccountScope | null | undefined,
        owner: AgentInputDraftOwner,
        options?: Readonly<{ flush?: boolean }>,
    ) => void;
    clearAgentInputLocalUiStateForSession: (
        scope: ServerAccountScope | null | undefined,
        sessionId: string,
        options?: Readonly<{ flush?: boolean }>,
    ) => void;
    clearAgentInputLocalUiStateForNewSession: (
        scope: ServerAccountScope | null | undefined,
        flowId: string,
        options?: Readonly<{ flush?: boolean }>,
    ) => void;
    garbageCollectAgentInputLocalUiState: (
        scope: ServerAccountScope | null | undefined,
        options: Readonly<{ now: number; reason: 'scopeActivated' | 'foreground' | 'idle'; flush?: boolean }>,
    ) => void;
    flushAgentInputLocalUiState: (scope?: ServerAccountScope | null) => void;
    invalidateAgentInputLocalUiStateCache: (scope?: ServerAccountScope | null) => void;
    resetAgentInputLocalUiStateCachesForTests: () => void;
}>;

type SessionLocalStateKeysModule = Readonly<{
    agentInputLocalUiStateStorageKey: (scope?: ServerAccountScope | null) => string;
}>;

type AgentInputLocalUiStatePersistenceModule = Readonly<{
    savePersistedAgentInputLocalUiState: (
        values: Record<string, unknown>,
        scope?: ServerAccountScope | null,
    ) => void;
    loadPersistedAgentInputLocalUiState: (
        scope?: ServerAccountScope | null,
    ) => Record<string, unknown>;
}>;

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };
const sessionOwner: AgentInputDraftOwner = { kind: 'session', sessionId: 'session-a' };
const otherSessionOwner: AgentInputDraftOwner = { kind: 'session', sessionId: 'session-b' };
const newSessionOwner: AgentInputDraftOwner = { kind: 'newSession', flowId: 'flow-a' };

async function importStore(): Promise<AgentInputLocalUiStateStoreModule> {
    return await import('./agentInputLocalUiStateStore');
}

async function importKeys(): Promise<SessionLocalStateKeysModule> {
    return await import('../../state/sessionLocalStateKeys');
}

async function importPersistence(): Promise<AgentInputLocalUiStatePersistenceModule> {
    return await import('../../state/agentInputLocalUiStatePersistence');
}

describe('agent input local UI-state store', () => {
    beforeEach(() => {
        store.clear();
        writesByKey.clear();
        vi.resetModules();
    });

    it('normalizes draft owners to stable scoped keys and rejects empty owners', async () => {
        const uiState = await importStore();

        expect(uiState.agentInputDraftOwnerKey(sessionOwner)).toBe('session:session-a');
        expect(uiState.agentInputDraftOwnerKey(newSessionOwner)).toBe('new-session:flow-a');
        expect(uiState.agentInputDraftOwnerKey({ kind: 'session', sessionId: '   ' })).toBeNull();
        expect(uiState.agentInputDraftOwnerKey({ kind: 'newSession', flowId: '' })).toBeNull();
    });

    it('patches and reads session-scoped UI state without leaking across owners or accounts', async () => {
        const uiState = await importStore();

        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, {
            expanded: true,
            scrollY: 42,
            selection: { start: 3, end: 7 },
            textLength: 50,
            fontScale: 1,
        }, { now: 100 });
        uiState.patchAgentInputLocalUiState(scopeB, sessionOwner, { expanded: false }, { now: 101 });

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toMatchObject({
            v: 1,
            expanded: true,
            scrollY: 42,
            selection: { start: 3, end: 7 },
            textLength: 50,
            fontScale: 1,
            updatedAt: 100,
        });
        expect(uiState.readAgentInputLocalUiState(scopeA, otherSessionOwner)).toBeNull();
        expect(uiState.readAgentInputLocalUiState(scopeB, sessionOwner)).toMatchObject({ expanded: false });
    });

    it('sanitizes malformed persisted UI state field-by-field', async () => {
        const persistence = await importPersistence();
        persistence.savePersistedAgentInputLocalUiState({
            'session:session-a': {
                v: 1,
                expanded: true,
                scrollY: -1,
                selection: { start: 9, end: 3 },
                textLength: 20,
                fontScale: 1,
                updatedAt: 100,
            },
            'session:session-b': {
                v: 1,
                scrollY: 10,
                selection: { start: 1, end: 2 },
                textLength: 10,
                updatedAt: 101,
            },
            'session:bad': { v: 2, updatedAt: 100 },
        }, scopeA);

        const uiState = await importStore();

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toEqual({
            v: 1,
            expanded: true,
            textLength: 20,
            fontScale: 1,
            updatedAt: 100,
        });
        expect(uiState.readAgentInputLocalUiState(scopeA, otherSessionOwner)).toMatchObject({
            scrollY: 10,
            selection: { start: 1, end: 2 },
        });
    });

    it('drops unsupported persisted owner key namespaces and flushes the quarantined map', async () => {
        const persistence = await importPersistence();
        const keys = await importKeys();
        const scopedKey = keys.agentInputLocalUiStateStorageKey(scopeA);
        persistence.savePersistedAgentInputLocalUiState({
            'session:session-a': {
                v: 1,
                expanded: true,
                updatedAt: 100,
            },
            'workspace:workspace-a': {
                v: 1,
                expanded: true,
                updatedAt: 101,
            },
            'new-session:': {
                v: 1,
                expanded: true,
                updatedAt: 102,
            },
        }, scopeA);
        writesByKey.clear();

        const uiState = await importStore();

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toMatchObject({ expanded: true });
        uiState.flushAgentInputLocalUiState(scopeA);

        expect(writesByKey.get(scopedKey)).toBe(1);
        expect(persistence.loadPersistedAgentInputLocalUiState(scopeA)).toEqual({
            'session:session-a': {
                v: 1,
                expanded: true,
                updatedAt: 100,
            },
        });
    });

    it('clamps selection and invalidates stale scroll when text length or font scale drifts', async () => {
        const uiState = await importStore();
        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, {
            scrollY: 80,
            selection: { start: 4, end: 30 },
            textLength: 30,
            fontScale: 1,
        }, { now: 100 });

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner, { textLength: 20, fontScale: 1 })).toMatchObject({
            scrollY: 80,
            selection: { start: 4, end: 20 },
        });
        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner, { textLength: 1, fontScale: 1 })).not.toHaveProperty('scrollY');
        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner, { textLength: 30, fontScale: 1.25 })).not.toHaveProperty('scrollY');
    });

    it('withholds the selection entirely when the stored text basis does not apply', async () => {
        // On session re-entry the composer mounts with empty text and the draft is adopted a
        // commit later, so the store is read with textLength 0. Returning a truthy clamped
        // {0,0} let the consumer restore "caret at start", which echoed straight back through
        // onSelectionChangePersist and overwrote the stored basis with textLength 0 — destroying
        // the real scroll/selection before the draft even loaded. Withhold it like scrollY.
        const uiState = await importStore();
        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, {
            scrollY: 240,
            selection: { start: 180, end: 180 },
            textLength: 400,
            fontScale: 1,
        }, { now: 100 });

        const atMount = uiState.readAgentInputLocalUiState(scopeA, sessionOwner, { textLength: 0, fontScale: 1 });
        expect(atMount).not.toHaveProperty('scrollY');
        expect(atMount?.selection).toBeUndefined();

        // Once the draft has been adopted the basis applies again and both are delivered.
        const afterDraftLoads = uiState.readAgentInputLocalUiState(scopeA, sessionOwner, { textLength: 400, fontScale: 1 });
        expect(afterDraftLoads).toMatchObject({
            scrollY: 240,
            selection: { start: 180, end: 180 },
        });
    });

    it('clears session and new-session owners independently and prunes empty maps', async () => {
        const uiState = await importStore();
        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, { expanded: true }, { now: 100, flush: false });
        uiState.patchAgentInputLocalUiState(scopeA, newSessionOwner, { expanded: true }, { now: 101, flush: false });

        uiState.clearAgentInputLocalUiStateForSession(scopeA, 'session-a', { flush: false });

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toBeNull();
        expect(uiState.readAgentInputLocalUiState(scopeA, newSessionOwner)).toMatchObject({ expanded: true });

        uiState.clearAgentInputLocalUiStateForNewSession(scopeA, 'flow-a');
        expect(uiState.readAgentInputLocalUiState(scopeA, newSessionOwner)).toBeNull();
    });

    it('garbage-collects stale UI state and preserves fresh UI state', async () => {
        const dayMs = 24 * 60 * 60 * 1000;
        const uiState = await importStore();
        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, { expanded: true }, {
            now: 1000,
            flush: false,
        });
        uiState.patchAgentInputLocalUiState(scopeA, otherSessionOwner, { expanded: true }, {
            now: 1000 + 6 * dayMs,
            flush: false,
        });

        uiState.garbageCollectAgentInputLocalUiState(scopeA, {
            now: 1000 + 8 * dayMs,
            reason: 'foreground',
        });

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toBeNull();
        expect(uiState.readAgentInputLocalUiState(scopeA, otherSessionOwner)).toMatchObject({ expanded: true });
    });

    it('dedupes unchanged patches and flushes only dirty scoped UI state', async () => {
        const uiState = await importStore();
        const keys = await importKeys();
        const scopedKey = keys.agentInputLocalUiStateStorageKey(scopeA);

        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, { expanded: true }, { now: 100 });
        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, { expanded: true }, { now: 200 });
        uiState.flushAgentInputLocalUiState(scopeA);

        expect(writesByKey.get(scopedKey)).toBe(1);
    });

    it('reloads scoped UI state after cache invalidation without leaking another account', async () => {
        const uiState = await importStore();
        const persistence = await importPersistence();

        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, { expanded: true }, { now: 100 });
        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toMatchObject({ expanded: true });

        persistence.savePersistedAgentInputLocalUiState({
            'session:session-a': {
                v: 1,
                expanded: false,
                updatedAt: 200,
            },
        }, scopeA);
        persistence.savePersistedAgentInputLocalUiState({
            'session:session-a': {
                v: 1,
                expanded: true,
                updatedAt: 300,
            },
        }, scopeB);

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toMatchObject({ expanded: true });

        uiState.invalidateAgentInputLocalUiStateCache(scopeA);

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toMatchObject({ expanded: false });
        expect(uiState.readAgentInputLocalUiState(scopeB, sessionOwner)).toMatchObject({ expanded: true });
    });

    it('ignores empty patches when no UI state exists for the owner', async () => {
        const uiState = await importStore();
        const keys = await importKeys();
        const scopedKey = keys.agentInputLocalUiStateStorageKey(scopeA);

        uiState.patchAgentInputLocalUiState(scopeA, sessionOwner, {}, { now: 100 });
        uiState.flushAgentInputLocalUiState(scopeA);

        expect(uiState.readAgentInputLocalUiState(scopeA, sessionOwner)).toBeNull();
        expect(writesByKey.get(scopedKey) ?? 0).toBe(0);
    });
});
