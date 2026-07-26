export type SessionMessageCommitRetryToken = Readonly<{
    localId: string;
    generation: number;
}>;

export type SessionMessageCommitRetryCurrent<Payload> = Readonly<{
    payload: Payload;
    attempts: number;
}>;

type RetryRecord<Payload, TimerHandle> = {
    generation: number;
    payload: Payload;
    attempts: number;
    timer: TimerHandle | null;
    timerEpoch: number;
};

export type SessionMessageCommitRetry<Payload> = Readonly<{
    beginIntent(localId: string, payload: Payload): SessionMessageCommitRetryToken;
    schedule(
        token: SessionMessageCommitRetryToken,
        onReady: (token: SessionMessageCommitRetryToken) => void,
    ): boolean;
    rescheduleCurrent(
        localId: string,
        onReady: (token: SessionMessageCommitRetryToken) => void,
    ): boolean;
    readCurrent(token: SessionMessageCommitRetryToken): SessionMessageCommitRetryCurrent<Payload> | null;
    complete(token: SessionMessageCommitRetryToken): boolean;
    completeCurrent(localId: string): boolean;
    dispose(): void;
    readonly size: number;
}>;

/**
 * Owns best-effort transcript retry generations for one session client.
 *
 * A token identifies an outbound intent, not merely a localId. Reusing a localId starts a newer
 * generation and makes every timer/callback from the older payload inert. Callers must re-read the
 * token inside their serialized commit closure immediately before sending; this prevents a timer
 * that was already queued from resurrecting stale content after a newer revision.
 */
export function createSessionMessageCommitRetry<Payload, TimerHandle>(params: Readonly<{
    maxAttempts: number;
    resolveDelayMs: (attempt: number) => number;
    scheduleTimer: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimer: (timer: TimerHandle) => void;
}>): SessionMessageCommitRetry<Payload> {
    const records = new Map<string, RetryRecord<Payload, TimerHandle>>();
    let nextGeneration = 1;
    let disposed = false;

    const readRecord = (token: SessionMessageCommitRetryToken): RetryRecord<Payload, TimerHandle> | null => {
        const record = records.get(token.localId);
        return record?.generation === token.generation ? record : null;
    };

    const clearRecordTimer = (record: RetryRecord<Payload, TimerHandle>): void => {
        if (record.timer === null) return;
        params.clearTimer(record.timer);
        record.timer = null;
        record.timerEpoch += 1;
    };

    const arm = (
        token: SessionMessageCommitRetryToken,
        onReady: (token: SessionMessageCommitRetryToken) => void,
        consumeAttempt: boolean,
    ): boolean => {
        if (disposed) return false;
        const record = readRecord(token);
        if (!record) return false;
        if (record.attempts >= params.maxAttempts) return false;

        clearRecordTimer(record);
        if (consumeAttempt) record.attempts += 1;
        const attempt = Math.max(1, record.attempts);
        const delayMs = Math.max(0, Math.trunc(params.resolveDelayMs(attempt)));
        const timerEpoch = record.timerEpoch + 1;
        record.timerEpoch = timerEpoch;
        record.timer = params.scheduleTimer(() => {
            const current = readRecord(token);
            if (!current || current.timerEpoch !== timerEpoch) return;
            current.timer = null;
            onReady(token);
        }, delayMs);
        return true;
    };

    return {
        beginIntent(localId, payload) {
            if (disposed) throw new Error('Session message commit retry owner is disposed');
            if (!localId) throw new Error('Session message commit retry requires a localId');
            const previous = records.get(localId);
            if (previous) clearRecordTimer(previous);
            const generation = nextGeneration++;
            records.set(localId, { generation, payload, attempts: 0, timer: null, timerEpoch: 0 });
            return { localId, generation };
        },
        schedule(token, onReady) {
            return arm(token, onReady, true);
        },
        rescheduleCurrent(localId, onReady) {
            const record = records.get(localId);
            if (!record) return false;
            return arm({ localId, generation: record.generation }, onReady, false);
        },
        readCurrent(token) {
            const record = readRecord(token);
            return record ? { payload: record.payload, attempts: record.attempts } : null;
        },
        complete(token) {
            const record = readRecord(token);
            if (!record) return false;
            clearRecordTimer(record);
            records.delete(token.localId);
            return true;
        },
        completeCurrent(localId) {
            const record = records.get(localId);
            if (!record) return false;
            clearRecordTimer(record);
            records.delete(localId);
            return true;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const record of records.values()) clearRecordTimer(record);
            records.clear();
        },
        get size() {
            return records.size;
        },
    };
}
