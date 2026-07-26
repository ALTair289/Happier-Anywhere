export type SessionMediaTurnAdmission<Item> = Readonly<{
  dedupeKey: string;
  item: Item;
}>;

export type SessionMediaTurnState<Item> = Readonly<{
  admit(items: readonly Item[]): SessionMediaTurnAdmission<Item>[];
  finish(dedupeKey: string, outcome: 'persisted' | 'unavailable' | 'release'): void;
  recordOverflow(count?: number): void;
  track(promise: Promise<void>): void;
  drain(): Promise<void>;
  takeOverflowCount(): number;
  reset(): void;
  readonly reservedSize: number;
  readonly pendingSize: number;
}>;

/**
 * Bounds the transient media work retained for one ACP turn.
 *
 * A dedupe key reserves one slot before asynchronous persistence begins. Persisted keys remain
 * terminal, unavailable keys may be retried in the same slot, and empty/failed attempts release
 * their slot. Settled promises remove themselves immediately instead of accumulating until flush.
 */
export function createSessionMediaTurnState<Item>(params: Readonly<{
  maxEntries: number;
  resolveDedupeKey: (item: Item) => string;
}>): SessionMediaTurnState<Item> {
  const maxEntries = Math.max(1, Math.trunc(params.maxEntries));
  const reservedKeys = new Set<string>();
  const persistedKeys = new Set<string>();
  const inFlightKeys = new Set<string>();
  const pendingPromises = new Set<Promise<void>>();
  let overflowCount = 0;

  const incrementOverflow = (count: number): void => {
    if (!Number.isFinite(count) || count <= 0) return;
    overflowCount = Math.min(Number.MAX_SAFE_INTEGER, overflowCount + Math.trunc(count));
  };

  return {
    admit(items) {
      const admitted: SessionMediaTurnAdmission<Item>[] = [];
      for (const item of items) {
        const dedupeKey = params.resolveDedupeKey(item);
        if (persistedKeys.has(dedupeKey) || inFlightKeys.has(dedupeKey)) continue;
        if (!reservedKeys.has(dedupeKey)) {
          if (reservedKeys.size >= maxEntries) {
            incrementOverflow(1);
            continue;
          }
          reservedKeys.add(dedupeKey);
        }
        inFlightKeys.add(dedupeKey);
        admitted.push({ dedupeKey, item });
      }
      return admitted;
    },
    finish(dedupeKey, outcome) {
      inFlightKeys.delete(dedupeKey);
      if (outcome === 'persisted') {
        persistedKeys.add(dedupeKey);
        return;
      }
      if (outcome === 'release') {
        persistedKeys.delete(dedupeKey);
        reservedKeys.delete(dedupeKey);
      }
    },
    recordOverflow(count = 1) {
      incrementOverflow(count);
    },
    track(promise) {
      pendingPromises.add(promise);
      void promise.finally(() => {
        pendingPromises.delete(promise);
      }).catch(() => undefined);
    },
    async drain() {
      while (pendingPromises.size > 0) {
        await Promise.allSettled([...pendingPromises]);
      }
    },
    takeOverflowCount() {
      const count = overflowCount;
      overflowCount = 0;
      return count;
    },
    reset() {
      reservedKeys.clear();
      persistedKeys.clear();
      inFlightKeys.clear();
      pendingPromises.clear();
      overflowCount = 0;
    },
    get reservedSize() {
      return reservedKeys.size;
    },
    get pendingSize() {
      return pendingPromises.size;
    },
  };
}
