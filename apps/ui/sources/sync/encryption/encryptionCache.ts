import { AgentState, Metadata, MachineMetadata } from '../domains/state/storageTypes';
import { DecryptedMessage } from '../domains/state/storageTypes';

interface CacheEntry<T> {
    data: T;
    accessTime: number;
    bytes: number;
}

type MessageCacheEntry = CacheEntry<DecryptedMessage> & {
    fingerprint: string;
    sessionId: string | null;
};

type OldestCacheEntryRef = {
    cache: Map<string, CacheEntry<unknown>>;
    key: string;
    accessTime: number;
};

type EncryptionCacheOptions = Readonly<{
    maxBytes?: number;
}>;

const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;

function normalizeMaxBytes(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_CACHE_BYTES;
    return Math.max(1, Math.trunc(value));
}

function estimateValueBytes(value: unknown, seen = new WeakSet<object>(), depth = 0): number {
    if (value == null) return 4;

    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;
    if (typeof value === 'bigint') return 8;
    if (typeof value !== 'object') return 8;

    if (ArrayBuffer.isView(value)) {
        return value.byteLength;
    }
    if (value instanceof ArrayBuffer) {
        return value.byteLength;
    }
    if (seen.has(value)) return 0;
    if (depth > 32) return 64;
    seen.add(value);

    if (Array.isArray(value)) {
        let total = 8;
        for (const entry of value) {
            total += estimateValueBytes(entry, seen, depth + 1);
        }
        return total;
    }

    let total = 16;
    for (const [key, entry] of Object.entries(value)) {
        total += key.length * 2;
        total += estimateValueBytes(entry, seen, depth + 1);
    }
    return total;
}

function estimateEntryBytes(data: unknown, extraKeys: readonly string[] = []): number {
    let total = estimateValueBytes(data);
    for (const key of extraKeys) {
        total += key.length * 2;
    }
    return Math.max(1, total);
}

/**
 * In-memory cache for decrypted session data to avoid expensive re-decryption
 * Uses sessionId + version as keys for agent state and metadata
 * Uses messageId + ciphertext fingerprint for messages (streaming can reuse ids)
 */
export class EncryptionCache {
    private agentStateCache = new Map<string, CacheEntry<AgentState>>();
    private metadataCache = new Map<string, CacheEntry<Metadata>>();
    private messageCache = new Map<string, MessageCacheEntry>();
    private machineMetadataCache = new Map<string, CacheEntry<MachineMetadata>>();
    private daemonStateCache = new Map<string, CacheEntry<any>>();
    private totalBytes = 0;
    private readonly maxBytes: number;
    
    // Configuration
    private readonly maxAgentStates = 1000;
    private readonly maxMetadata = 1000;
    private readonly maxMessages = 1000;
    private readonly maxMachineMetadata = 500;
    private readonly maxDaemonStates = 500;

    constructor(options: EncryptionCacheOptions = {}) {
        this.maxBytes = normalizeMaxBytes(options.maxBytes);
    }

    /**
     * Get cached agent state for a session
     */
    getCachedAgentState(sessionId: string, version: number): AgentState | null {
        const key = `${sessionId}:${version}`;
        const entry = this.agentStateCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache agent state for a session
     */
    setCachedAgentState(sessionId: string, version: number, data: AgentState): void {
        const key = `${sessionId}:${version}`;
        this.setEntry(this.agentStateCache, key, {
            data,
            accessTime: Date.now(),
            bytes: estimateEntryBytes(data, [key]),
        }, this.maxAgentStates);
    }

    /**
     * Get cached metadata for a session
     */
    getCachedMetadata(sessionId: string, version: number): Metadata | null {
        const key = `${sessionId}:${version}`;
        const entry = this.metadataCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache metadata for a session
     */
    setCachedMetadata(sessionId: string, version: number, data: Metadata): void {
        const key = `${sessionId}:${version}`;
        this.setEntry(this.metadataCache, key, {
            data,
            accessTime: Date.now(),
            bytes: estimateEntryBytes(data, [key]),
        }, this.maxMetadata);
    }

    /**
     * Get cached decrypted message
     */
    getCachedMessage(messageId: string, fingerprint: string): DecryptedMessage | null {
        const entry = this.messageCache.get(messageId);
        if (entry) {
            if (entry.fingerprint !== fingerprint) {
                return null;
            }
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache decrypted message
     */
    setCachedMessage(messageId: string, data: DecryptedMessage, fingerprint: string, sessionId?: string | null): void {
        this.setEntry(this.messageCache, messageId, {
            data,
            accessTime: Date.now(),
            fingerprint,
            sessionId: sessionId ?? null,
            bytes: estimateEntryBytes(data, [messageId, fingerprint, sessionId ?? '']),
        }, this.maxMessages);
    }

    /**
     * Get cached machine metadata
     */
    getCachedMachineMetadata(machineId: string, version: number): MachineMetadata | null {
        const key = `${machineId}:${version}`;
        const entry = this.machineMetadataCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache machine metadata
     */
    setCachedMachineMetadata(machineId: string, version: number, data: MachineMetadata): void {
        const key = `${machineId}:${version}`;
        this.setEntry(this.machineMetadataCache, key, {
            data,
            accessTime: Date.now(),
            bytes: estimateEntryBytes(data, [key]),
        }, this.maxMachineMetadata);
    }

    /**
     * Get cached daemon state
     */
    getCachedDaemonState(machineId: string, version: number): any | undefined {
        const key = `${machineId}:${version}`;
        const entry = this.daemonStateCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return undefined;
    }

    /**
     * Cache daemon state (including null values)
     */
    setCachedDaemonState(machineId: string, version: number, data: any): void {
        const key = `${machineId}:${version}`;
        this.setEntry(this.daemonStateCache, key, {
            data,
            accessTime: Date.now(),
            bytes: estimateEntryBytes(data, [key]),
        }, this.maxDaemonStates);
    }

    /**
     * Clear all cache entries for a specific machine
     */
    clearMachineCache(machineId: string): void {
        // Clear machine metadata and daemon state for this machine (all versions)
        for (const key of this.machineMetadataCache.keys()) {
            if (key.startsWith(`${machineId}:`)) {
                this.deleteEntry(this.machineMetadataCache, key);
            }
        }
        
        for (const key of this.daemonStateCache.keys()) {
            if (key.startsWith(`${machineId}:`)) {
                this.deleteEntry(this.daemonStateCache, key);
            }
        }
    }

    /**
     * Clear all cache entries for a specific session
     */
    clearSession(sessionId: string): void {
        // Clear agent state and metadata for this session (all versions)
        for (const key of this.agentStateCache.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.deleteEntry(this.agentStateCache, key);
            }
        }
        
        for (const key of this.metadataCache.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.deleteEntry(this.metadataCache, key);
            }
        }

        for (const [key, entry] of this.messageCache.entries()) {
            if (entry.sessionId === sessionId) {
                this.deleteEntry(this.messageCache, key);
            }
        }
    }

    clearSessionCache(sessionId: string): void {
        this.clearSession(sessionId);
    }

    /**
     * Clear all cached data
     */
    clearAll(): void {
        this.agentStateCache.clear();
        this.metadataCache.clear();
        this.messageCache.clear();
        this.machineMetadataCache.clear();
        this.daemonStateCache.clear();
        this.totalBytes = 0;
    }

    /**
     * Get cache statistics for debugging
     */
    getStats() {
        return {
            agentStates: this.agentStateCache.size,
            metadata: this.metadataCache.size,
            messages: this.messageCache.size,
            machineMetadata: this.machineMetadataCache.size,
            daemonStates: this.daemonStateCache.size,
            totalEntries: this.agentStateCache.size + this.metadataCache.size + this.messageCache.size + 
                         this.machineMetadataCache.size + this.daemonStateCache.size,
            totalBytes: this.totalBytes,
            maxBytes: this.maxBytes,
        };
    }

    private setEntry<T, Entry extends CacheEntry<T>>(
        cache: Map<string, Entry>,
        key: string,
        entry: Entry,
        maxSize: number,
    ): void {
        const previous = cache.get(key);
        if (previous) {
            this.totalBytes -= previous.bytes;
        }
        cache.set(key, entry);
        this.totalBytes += entry.bytes;
        this.evictOldest(cache, maxSize);
        this.evictToByteBudget();
    }

    private deleteEntry<T, Entry extends CacheEntry<T>>(cache: Map<string, Entry>, key: string): void {
        const entry = cache.get(key);
        if (!entry) return;
        this.totalBytes -= entry.bytes;
        cache.delete(key);
    }

    /**
     * Evict oldest entries when cache exceeds limit (LRU eviction)
     */
    private evictOldest<T>(cache: Map<string, CacheEntry<T>>, maxSize: number): void {
        if (cache.size <= maxSize) {
            return;
        }

        // Find oldest entry by access time
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        
        for (const [key, entry] of cache.entries()) {
            if (entry.accessTime < oldestTime) {
                oldestTime = entry.accessTime;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            this.deleteEntry(cache, oldestKey);
        }
    }

    private evictToByteBudget(): void {
        while (this.totalBytes > this.maxBytes) {
            const oldest = this.findOldestEntry();
            if (!oldest) return;
            this.deleteEntry(oldest.cache, oldest.key);
        }
    }

    private findOldestEntry(): { cache: Map<string, CacheEntry<unknown>>; key: string } | null {
        const visit = <T>(
            cache: Map<string, CacheEntry<T>>,
            current: OldestCacheEntryRef | null,
        ): OldestCacheEntryRef | null => {
            let oldest = current;
            for (const [key, entry] of cache.entries()) {
                if (!oldest || entry.accessTime < oldest.accessTime) {
                    oldest = {
                        cache: cache as unknown as Map<string, CacheEntry<unknown>>,
                        key,
                        accessTime: entry.accessTime,
                    };
                }
            }
            return oldest;
        };

        let oldest: OldestCacheEntryRef | null = null;
        oldest = visit(this.agentStateCache, oldest);
        oldest = visit(this.metadataCache, oldest);
        oldest = visit(this.messageCache, oldest);
        oldest = visit(this.machineMetadataCache, oldest);
        oldest = visit(this.daemonStateCache, oldest);

        return oldest ? { cache: oldest.cache, key: oldest.key } : null;
    }
}
