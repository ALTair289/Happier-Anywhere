type MmkvStubConfig = Readonly<{ id?: string; encryptionKey?: string }>;

const DEFAULT_INSTANCE_ID = 'mmkv.default';

/**
 * One in-memory store per MMKV instance id, because that is what MMKV is: a file per id. Instances
 * sharing an id share a store (production constructs its own `MMKV` per persistence module and
 * tests assert across those modules); instances with different ids do not, so a module that moves
 * its data to a new id cannot appear to still be reading the old one.
 */
const storesById = new Map<string, Map<string, unknown>>();

function storeFor(id: string): Map<string, unknown> {
    const existing = storesById.get(id);
    if (existing) return existing;
    const created = new Map<string, unknown>();
    storesById.set(id, created);
    return created;
}

export function resetReactNativeMmkvStub(): void {
    // Clear each store in place rather than dropping the registry: production modules cache their
    // `MMKV` instance, and that instance holds the map it was constructed with, so a reset that
    // only forgot the entry would leak one test's bytes into the next.
    for (const store of storesById.values()) store.clear();
}

/**
 * Read-only view of everything the stubbed MMKV boundary currently holds, across every instance id.
 * Tests that need to assert on persisted bytes use this instead of re-declaring their own MMKV
 * mock, so the stub stays the single owner of the boundary surface.
 */
export function readReactNativeMmkvStubEntries(): readonly (readonly [string, unknown])[] {
    return [...storesById.values()].flatMap((store) => [...store.entries()]);
}

export function readReactNativeMmkvStubValues(): readonly unknown[] {
    return readReactNativeMmkvStubEntries().map(([, value]) => value);
}

export class MMKV {
    private readonly values: Map<string, unknown>;

    constructor(config?: MmkvStubConfig) {
        this.values = storeFor(config?.id ?? DEFAULT_INSTANCE_ID);
    }

    getString(key: string): string | undefined {
        const value = this.values.get(key);
        return typeof value === 'string' ? value : undefined;
    }

    getNumber(key: string): number | undefined {
        const value = this.values.get(key);
        return typeof value === 'number' ? value : undefined;
    }

    set(key: string, value: unknown): void {
        this.values.set(key, value);
    }

    delete(key: string): void {
        this.values.delete(key);
    }

    getAllKeys(): string[] {
        return [...this.values.keys()];
    }

    clearAll(): void {
        this.values.clear();
    }

    /**
     * No-op, because this stub has nothing to compact — it is a `Map`, so a deleted key is already
     * gone rather than tombstoned in an append-only file.
     *
     * It exists so callers that must compact on the real device (the plaintext warm-cache purge in
     * `warmCachePersistence.ts`, where the deleted values are the very bytes being retired) can call
     * it without throwing here. Without this method that call would throw inside the purge's own
     * `catch`, which would swallow it and leave the test green while the device kept the plaintext.
     */
    trim(): void {
        // Intentionally empty; see above.
    }
}
