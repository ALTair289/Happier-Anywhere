import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerProfile } from '../../domains/server/serverProfiles';
import { WARM_CACHE_STORAGE_ID } from '../../domains/state/warmCachePersistence';

const ACCOUNT_ID = 'account_a';
const SERVER_ID = 'server_a';
const MACHINE_DISPLAY_WARM_CACHE_KEY = `machine-display-warm-cache-v1:${SERVER_ID}:${ACCOUNT_ID}`;

// One map per MMKV instance id, because the warm cache now lives in its own encrypted instance and
// a conflated double would let a read of the retired plaintext instance pass for a read of it.
const mmkv = vi.hoisted(() => {
    const storesById = new Map<string, Map<string, string>>();
    const setCallsById = new Map<string, Map<string, number>>();
    function mapFor<T>(byId: Map<string, Map<string, T>>, id: string): Map<string, T> {
        const existing = byId.get(id);
        if (existing) return existing;
        const created = new Map<string, T>();
        byId.set(id, created);
        return created;
    }
    return {
        storeFor: (id: string) => mapFor(storesById, id),
        setCallsFor: (id: string) => mapFor(setCallsById, id),
        reset: () => {
            storesById.clear();
            setCallsById.clear();
        },
    };
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        private readonly instanceId: string;

        constructor(config?: { id?: string }) {
            this.instanceId = config?.id ?? 'mmkv.default';
        }

        getString(key: string) {
            return mmkv.storeFor(this.instanceId).get(key);
        }

        set(key: string, value: string) {
            const calls = mmkv.setCallsFor(this.instanceId);
            calls.set(key, (calls.get(key) ?? 0) + 1);
            mmkv.storeFor(this.instanceId).set(key, value);
        }

        delete(key: string) {
            mmkv.storeFor(this.instanceId).delete(key);
        }

        getAllKeys() {
            return [...mmkv.storeFor(this.instanceId).keys()];
        }
    }

    return { MMKV };
});

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mmkv.reset();
});

afterEach(() => {
    vi.useRealTimers();
});

function createServerProfile(id: string): ServerProfile {
    return {
        id,
        name: id,
        serverUrl: `http://${id}.local`,
        serverIdentityId: null,
        legacyServerIds: [],
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
    };
}

function mockMachineDomainBoundaries(): void {
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({ serverId: SERVER_ID, serverUrl: `http://${SERVER_ID}.local`, generation: 0 }),
    }));
    vi.doMock('../../domains/server/serverProfiles', async (importOriginal) => {
        const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
        return createServerProfilesModuleMock({
            importOriginal,
            overrides: {
                listServerProfiles: () => [createServerProfile(SERVER_ID)],
            },
        });
    });
}

function createHarness(createMachinesDomain: any) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        machines: {},
        machineDisplayById: {},
        machineListByServerId: {},
        machineListStatusByServerId: {},
        profile: { id: ACCOUNT_ID },
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    return { domain: createMachinesDomain({ get, set } as any), get };
}

function seedWarmCacheBlob(machineCount: number): void {
    const entries: Record<string, unknown> = {};
    for (let index = 0; index < machineCount; index += 1) {
        const machineId = `m${index}`;
        entries[machineId] = {
            machineId,
            metadataVersion: 1,
            updatedAt: 1_000 + index,
            active: index % 2 === 0,
            activeAt: 1_000 + index,
            revokedAt: null,
            displayName: `Machine ${index}`,
            host: `host-${index}.local`,
            homeDir: '/home/u',
        };
    }
    warmCacheStore().set(MACHINE_DISPLAY_WARM_CACHE_KEY, JSON.stringify(entries));
}

function warmCacheStore(): Map<string, string> {
    return mmkv.storeFor(WARM_CACHE_STORAGE_ID);
}

function warmCacheSetCalls(): Map<string, number> {
    return mmkv.setCallsFor(WARM_CACHE_STORAGE_ID);
}

async function hydrateWarmCacheIntoDomain(domain: any) {
    // The cache is encrypted at rest, so nothing reads or writes it until the at-rest key resolves.
    const { prepareWarmCacheEncryptionKey } = await import('../../domains/state/warmCacheEncryptionKey');
    await prepareWarmCacheEncryptionKey();
    const { loadMachineDisplayWarmCacheEntries } = await import('../../domains/state/warmCachePersistence');
    const { buildMachineDisplayRenderableFromCacheEntry } = await import('../../domains/state/warmCacheAdapters');
    const entries = loadMachineDisplayWarmCacheEntries(SERVER_ID, ACCOUNT_ID);
    domain.replaceMachineDisplays(
        Object.values(entries).map((entry) => buildMachineDisplayRenderableFromCacheEntry(entry)),
    );
    return entries;
}

describe('machines domain: warm-cache boot hydration', () => {
    it('writes nothing back to the warm-cache key while publishing the cached machines', async () => {
        vi.useFakeTimers();
        mockMachineDomainBoundaries();
        seedWarmCacheBlob(12);
        const { createMachinesDomain } = await import('./machines');
        const { domain, get } = createHarness(createMachinesDomain);

        const entries = await hydrateWarmCacheIntoDomain(domain);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(Object.keys(entries)).toHaveLength(12);
        expect(Object.keys(get().machineDisplayById)).toHaveLength(12);
        expect(warmCacheSetCalls().get(MACHINE_DISPLAY_WARM_CACHE_KEY) ?? 0).toBe(0);
    });

    it('still persists the cache once real data changes a hydrated machine', async () => {
        vi.useFakeTimers();
        mockMachineDomainBoundaries();
        seedWarmCacheBlob(3);
        const { createMachinesDomain } = await import('./machines');
        const { domain, get } = createHarness(createMachinesDomain);

        await hydrateWarmCacheIntoDomain(domain);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(warmCacheSetCalls().get(MACHINE_DISPLAY_WARM_CACHE_KEY) ?? 0).toBe(0);

        const hydrated = get().machineDisplayById.m1;
        domain.replaceMachineDisplays(
            Object.values(get().machineDisplayById).map((renderable: any) => (
                renderable.id === 'm1'
                    ? { ...hydrated, active: !hydrated.active, activeAt: hydrated.activeAt + 5 }
                    : renderable
            )),
        );
        await vi.advanceTimersByTimeAsync(1_000);

        expect(warmCacheSetCalls().get(MACHINE_DISPLAY_WARM_CACHE_KEY) ?? 0).toBe(1);
        expect(JSON.parse(warmCacheStore().get(MACHINE_DISPLAY_WARM_CACHE_KEY) ?? '{}').m1.activeAt)
            .toBe(hydrated.activeAt + 5);
    });
});
