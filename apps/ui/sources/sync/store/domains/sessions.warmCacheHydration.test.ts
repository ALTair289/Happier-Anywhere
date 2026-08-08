import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installPersistenceModuleMock } from '@/dev/testkit';
import { purchasesDefaults } from '@/sync/domains/purchases/purchases';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

const ACCOUNT_ID = 'account_a';
const SERVER_ID = 'server_a';
const SESSION_LIST_WARM_CACHE_KEY = `session-list-warm-cache-v1:${SERVER_ID}:${ACCOUNT_ID}`;

const mmkv = vi.hoisted(() => ({
    store: new Map<string, string>(),
    setCallsByKey: new Map<string, number>(),
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkv.store.get(key);
        }

        set(key: string, value: string) {
            mmkv.setCallsByKey.set(key, (mmkv.setCallsByKey.get(key) ?? 0) + 1);
            mmkv.store.set(key, value);
        }

        delete(key: string) {
            mmkv.store.delete(key);
        }
    }

    return { MMKV };
});

const storageStateRef = vi.hoisted(() => ({ current: null as any }));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mmkv.store.clear();
    mmkv.setCallsByKey.clear();
    storageStateRef.current = null;
});

function mockSessionBoundaries(): void {
    vi.doMock('../../domains/state/persistence', installPersistenceModuleMock({
        loadProfile: vi.fn(() => ({ ...profileDefaults, id: ACCOUNT_ID })),
        saveProfile: vi.fn(),
        loadSessionDrafts: vi.fn(() => ({})),
        loadSessionLastViewed: vi.fn(() => ({})),
        loadSessionModelModeUpdatedAts: vi.fn(() => ({})),
        loadSessionModelModes: vi.fn(() => ({})),
        loadSessionPermissionModeUpdatedAts: vi.fn(() => ({})),
        loadSessionPermissionModes: vi.fn(() => ({})),
        loadSessionActionDrafts: vi.fn(() => ({})),
        loadSessionReviewCommentsDrafts: vi.fn(() => ({})),
        loadWorkspaceReviewCommentsDrafts: vi.fn(() => ({})),
        saveSessionDrafts: vi.fn(),
        saveSessionLastViewed: vi.fn(),
        loadSettings: vi.fn(() => ({ settings: { preferredLanguage: 'en' }, version: null })),
        loadLocalSettings: vi.fn(() => ({ ...localSettingsDefaults })),
        loadPurchases: vi.fn(() => ({ ...purchasesDefaults })),
        saveSessionModelModeUpdatedAts: vi.fn(),
        saveSessionModelModes: vi.fn(),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        saveSessionPermissionModes: vi.fn(),
        saveSessionActionDrafts: vi.fn(),
        saveSessionReviewCommentsDrafts: vi.fn(),
        saveWorkspaceReviewCommentsDrafts: vi.fn(),
        saveLocalSettings: vi.fn(),
        savePurchases: vi.fn(),
        saveSettings: vi.fn(),
    }));
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({ serverId: SERVER_ID, serverUrl: 'https://example.test' }),
        subscribeActiveServer: () => () => undefined,
    }));
    vi.doMock('@/sync/domains/models/modelOptions', () => ({
        isModelSelectableForSession: vi.fn(() => true),
    }));
    vi.doMock('@/agents/catalog/catalog', () => ({
        AGENT_IDS: [],
        DEFAULT_AGENT_ID: 'openai',
        resolveAgentIdFromFlavor: vi.fn(() => null),
    }));
    vi.doMock('../../domains/state/storage', async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => storageStateRef.current,
                getInitialState: () => storageStateRef.current,
                setState: () => undefined,
                subscribe: () => () => undefined,
                destroy: () => undefined,
            },
        } as any);
    });
}

function createHarness(createSessionsDomain: any) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        profile: { id: ACCOUNT_ID },
        settings: { groupInactiveSessionsByProject: false },
    };
    storageStateRef.current = state;

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
        storageStateRef.current = state;
    };

    return { domain: createSessionsDomain({ get, set } as any), get };
}

function seedWarmCacheBlob(sessionCount: number): void {
    const entries: Record<string, unknown> = {};
    for (let index = 0; index < sessionCount; index += 1) {
        const sessionId = `s${index}`;
        entries[sessionId] = {
            sessionId,
            seq: index,
            metadataVersion: 1,
            agentStateVersion: 1,
            updatedAt: 1_000 + index,
            meaningfulActivityAt: 1_000 + index,
            createdAt: 1_000 + index,
            active: false,
            activeAt: 1_000 + index,
            archivedAt: null,
            lastViewedSessionSeq: index,
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            name: `Session ${index}`,
            summaryText: null,
            flavor: 'codex',
            directSessionV1: null,
            hiddenSystemSession: false,
        };
    }
    mmkv.store.set(SESSION_LIST_WARM_CACHE_KEY, JSON.stringify(entries));
}

async function hydrateWarmCacheIntoDomain(domain: any) {
    const { loadSessionListWarmCacheEntries } = await import('../../domains/state/warmCachePersistence');
    const { buildSessionListRenderableFromCacheEntry } = await import('../../domains/state/warmCacheAdapters');
    const entries = loadSessionListWarmCacheEntries(SERVER_ID, ACCOUNT_ID);
    domain.replaceSessionListRenderables(
        Object.values(entries).map((entry) => buildSessionListRenderableFromCacheEntry(entry)),
    );
    return entries;
}

describe('sessions domain: warm-cache boot hydration', () => {
    it('writes nothing back to the warm-cache key while publishing the cached rows', async () => {
        mockSessionBoundaries();
        seedWarmCacheBlob(12);
        const { createSessionsDomain } = await import('./sessions');
        const { domain, get } = createHarness(createSessionsDomain);

        const entries = await hydrateWarmCacheIntoDomain(domain);

        expect(Object.keys(entries)).toHaveLength(12);
        expect(Object.keys(get().sessionListRenderables)).toHaveLength(12);
        expect(mmkv.setCallsByKey.get(SESSION_LIST_WARM_CACHE_KEY) ?? 0).toBe(0);
    });

    it('trims an oversized legacy blob down to the retained window on the first hydration', async () => {
        mockSessionBoundaries();
        const { SESSION_LIST_WARM_CACHE_MAX_ENTRIES } = await import('../../domains/state/warmCacheAdapters');
        seedWarmCacheBlob(SESSION_LIST_WARM_CACHE_MAX_ENTRIES + 40);
        const { createSessionsDomain } = await import('./sessions');
        const { domain, get } = createHarness(createSessionsDomain);

        await hydrateWarmCacheIntoDomain(domain);

        expect(Object.keys(get().sessionListRenderables)).toHaveLength(SESSION_LIST_WARM_CACHE_MAX_ENTRIES);
        expect(mmkv.setCallsByKey.get(SESSION_LIST_WARM_CACHE_KEY) ?? 0).toBe(1);
        expect(Object.keys(JSON.parse(mmkv.store.get(SESSION_LIST_WARM_CACHE_KEY) ?? '{}')))
            .toHaveLength(SESSION_LIST_WARM_CACHE_MAX_ENTRIES);
    });

    it('still persists the cache once real data changes a hydrated row', async () => {
        mockSessionBoundaries();
        seedWarmCacheBlob(3);
        const { createSessionsDomain } = await import('./sessions');
        const { domain, get } = createHarness(createSessionsDomain);

        await hydrateWarmCacheIntoDomain(domain);
        expect(mmkv.setCallsByKey.get(SESSION_LIST_WARM_CACHE_KEY) ?? 0).toBe(0);

        const hydrated = get().sessionListRenderables.s1;
        domain.replaceSessionListRenderables(
            Object.values(get().sessionListRenderables).map((renderable: any) => (
                renderable.id === 's1'
                    ? { ...hydrated, seq: hydrated.seq + 5, updatedAt: hydrated.updatedAt + 5, active: true }
                    : renderable
            )),
        );

        expect(mmkv.setCallsByKey.get(SESSION_LIST_WARM_CACHE_KEY) ?? 0).toBe(1);
        expect(JSON.parse(mmkv.store.get(SESSION_LIST_WARM_CACHE_KEY) ?? '{}').s1.active).toBe(true);
    });
});
