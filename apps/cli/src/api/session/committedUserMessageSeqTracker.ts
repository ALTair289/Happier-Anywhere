export const DEFAULT_COMMITTED_USER_MESSAGE_SEQ_WAIT_TIMEOUT_MS = 5_000;
export const DEFAULT_COMMITTED_USER_MESSAGE_SEQ_TRACKER_MAX_ENTRIES = 256;

export type CommittedUserMessageSeqWaitOptions = Readonly<{
    timeoutMs?: number;
}>;

type Waiter = {
    resolve: (seq: number | null) => void;
    timeout: ReturnType<typeof setTimeout>;
};

function normalizePositiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.trunc(value))
        : fallback;
}

function normalizeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

export class CommittedUserMessageSeqTracker {
    private readonly committedSeqByLocalId = new Map<string, number>();
    private readonly waitersByLocalId = new Map<string, Set<Waiter>>();

    constructor(
        private readonly maxEntries: number = DEFAULT_COMMITTED_USER_MESSAGE_SEQ_TRACKER_MAX_ENTRIES,
    ) {}

    get(localId: string): number | null {
        return this.committedSeqByLocalId.get(localId) ?? null;
    }

    record(localId: string | null | undefined, seq: unknown): number | null {
        const pendingLocalId = readPendingLocalId(localId);
        if (pendingLocalId === null) {
            return null;
        }
        const normalizedSeq = normalizeSeq(seq);
        if (normalizedSeq === null) {
            return null;
        }

        const existingSeq = this.committedSeqByLocalId.get(pendingLocalId) ?? null;
        if (existingSeq !== null) {
            this.resolveWaiters(pendingLocalId, existingSeq);
            return existingSeq;
        }

        this.committedSeqByLocalId.set(pendingLocalId, normalizedSeq);
        this.trimCommittedSeqs();
        this.resolveWaiters(pendingLocalId, normalizedSeq);
        return normalizedSeq;
    }

    wait(localId: string, options: CommittedUserMessageSeqWaitOptions = {}): Promise<number | null> {
        const existing = this.get(localId);
        if (existing !== null) {
            return Promise.resolve(existing);
        }
        if (readPendingLocalId(localId) === null) {
            return Promise.resolve(null);
        }

        const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_COMMITTED_USER_MESSAGE_SEQ_WAIT_TIMEOUT_MS);

        return new Promise((resolve) => {
            const cleanup = (waiter: Waiter) => {
                clearTimeout(waiter.timeout);
                const waiters = this.waitersByLocalId.get(localId);
                waiters?.delete(waiter);
                if (waiters && waiters.size === 0) {
                    this.waitersByLocalId.delete(localId);
                }
            };
            const finish = (waiter: Waiter, seq: number | null) => {
                cleanup(waiter);
                resolve(seq);
            };
            const waiter: Waiter = {
                resolve: (seq) => finish(waiter, seq),
                timeout: setTimeout(() => finish(waiter, null), timeoutMs),
            };
            waiter.timeout.unref?.();

            const waiters = this.waitersByLocalId.get(localId) ?? new Set<Waiter>();
            waiters.add(waiter);
            this.waitersByLocalId.set(localId, waiters);
        });
    }

    clear(): void {
        this.committedSeqByLocalId.clear();
        for (const waiters of this.waitersByLocalId.values()) {
            for (const waiter of waiters) {
                clearTimeout(waiter.timeout);
                waiter.resolve(null);
            }
        }
        this.waitersByLocalId.clear();
    }

    private resolveWaiters(localId: string, seq: number): void {
        const waiters = this.waitersByLocalId.get(localId);
        if (!waiters) {
            return;
        }
        for (const waiter of [...waiters]) {
            waiter.resolve(seq);
        }
    }

    private trimCommittedSeqs(): void {
        const maxEntries = Math.max(1, Math.trunc(this.maxEntries));
        while (this.committedSeqByLocalId.size > maxEntries) {
            const oldest = this.committedSeqByLocalId.keys().next().value;
            if (typeof oldest !== 'string') {
                return;
            }
            this.committedSeqByLocalId.delete(oldest);
        }
    }
}
import { readPendingLocalId } from '@happier-dev/protocol';
