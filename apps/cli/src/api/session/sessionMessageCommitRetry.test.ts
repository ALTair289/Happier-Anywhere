import { describe, expect, it } from 'vitest';

import { createSessionMessageCommitRetry } from './sessionMessageCommitRetry';

type TimerTask = Readonly<{
    id: number;
    callback: () => void;
    delayMs: number;
}>;

function createManualTimers() {
    let nextId = 1;
    const tasks = new Map<number, TimerTask>();
    const cleared = new Set<number>();

    return {
        schedule(callback: () => void, delayMs: number): number {
            const id = nextId++;
            tasks.set(id, { id, callback, delayMs });
            return id;
        },
        clear(id: number): void {
            cleared.add(id);
        },
        run(id: number, options: Readonly<{ evenIfCleared?: boolean }> = {}): void {
            const task = tasks.get(id);
            if (!task) throw new Error(`Unknown timer ${id}`);
            if (!cleared.has(id) || options.evenIfCleared === true) task.callback();
        },
        latest(): TimerTask {
            const task = [...tasks.values()].at(-1);
            if (!task) throw new Error('No timer scheduled');
            return task;
        },
        wasCleared(id: number): boolean {
            return cleared.has(id);
        },
    };
}

describe('createSessionMessageCommitRetry', () => {
    it('supersedes a captured older payload and makes its cleared callback inert', () => {
        const timers = createManualTimers();
        const retry = createSessionMessageCommitRetry<string, number>({
            maxAttempts: 3,
            resolveDelayMs: (attempt) => attempt * 1_000,
            scheduleTimer: timers.schedule,
            clearTimer: timers.clear,
        });
        const ready: string[] = [];

        const first = retry.beginIntent('same-local-id', 'revision-1');
        expect(retry.schedule(first, (token) => {
            const current = retry.readCurrent(token);
            if (current) ready.push(current.payload);
        })).toBe(true);
        const firstTimer = timers.latest();

        const second = retry.beginIntent('same-local-id', 'revision-2');

        expect(timers.wasCleared(firstTimer.id)).toBe(true);
        timers.run(firstTimer.id, { evenIfCleared: true });
        expect(ready).toEqual([]);
        expect(retry.readCurrent(first)).toBeNull();
        expect(retry.readCurrent(second)?.payload).toBe('revision-2');
    });

    it('re-checks generation after timer readiness so a queued callback cannot send stale content', () => {
        const timers = createManualTimers();
        const retry = createSessionMessageCommitRetry<string, number>({
            maxAttempts: 3,
            resolveDelayMs: () => 1,
            scheduleTimer: timers.schedule,
            clearTimer: timers.clear,
        });
        const queued: Array<() => void> = [];
        const sent: string[] = [];
        const first = retry.beginIntent('same-local-id', 'revision-1');
        retry.schedule(first, (token) => {
            queued.push(() => {
                const current = retry.readCurrent(token);
                if (current) sent.push(current.payload);
            });
        });

        timers.run(timers.latest().id);
        retry.beginIntent('same-local-id', 'revision-2');
        queued[0]?.();

        expect(sent).toEqual([]);
    });

    it('resets the retry budget for a newer generation after the older one is exhausted', () => {
        const timers = createManualTimers();
        const retry = createSessionMessageCommitRetry<string, number>({
            maxAttempts: 2,
            resolveDelayMs: (attempt) => attempt,
            scheduleTimer: timers.schedule,
            clearTimer: timers.clear,
        });
        const first = retry.beginIntent('same-local-id', 'revision-1');

        expect(retry.schedule(first, () => undefined)).toBe(true);
        timers.run(timers.latest().id);
        expect(retry.schedule(first, () => undefined)).toBe(true);
        timers.run(timers.latest().id);
        expect(retry.schedule(first, () => undefined)).toBe(false);

        const second = retry.beginIntent('same-local-id', 'revision-2');
        expect(retry.readCurrent(second)?.attempts).toBe(0);
        expect(retry.schedule(second, () => undefined)).toBe(true);
    });

    it('allows only the matching generation to complete or reject the current intent', () => {
        const timers = createManualTimers();
        const retry = createSessionMessageCommitRetry<string, number>({
            maxAttempts: 3,
            resolveDelayMs: () => 1,
            scheduleTimer: timers.schedule,
            clearTimer: timers.clear,
        });
        const first = retry.beginIntent('same-local-id', 'revision-1');
        const second = retry.beginIntent('same-local-id', 'revision-2');

        expect(retry.complete(first)).toBe(false);
        expect(retry.readCurrent(second)?.payload).toBe('revision-2');
        expect(retry.complete(second)).toBe(true);
        expect(retry.size).toBe(0);
    });

  it('can reschedule the current generation after reconnect and clears it on materialization', () => {
        const timers = createManualTimers();
        const retry = createSessionMessageCommitRetry<string, number>({
            maxAttempts: 3,
            resolveDelayMs: () => 1,
            scheduleTimer: timers.schedule,
            clearTimer: timers.clear,
        });
        const token = retry.beginIntent('same-local-id', 'revision-1');
        const ready: string[] = [];
        retry.schedule(token, () => ready.push('stale-timer-fired'));
        const firstTimer = timers.latest();

        expect(retry.rescheduleCurrent('same-local-id', (currentToken) => {
            const current = retry.readCurrent(currentToken);
            if (current) ready.push(current.payload);
        })).toBe(true);
        expect(timers.wasCleared(firstTimer.id)).toBe(true);
        timers.run(firstTimer.id, { evenIfCleared: true });
        expect(ready).toEqual([]);
        expect(retry.readCurrent(token)?.attempts).toBe(1);
        expect(retry.completeCurrent('same-local-id')).toBe(true);
        expect(retry.size).toBe(0);
    });

    it('does not reopen an exhausted retry budget on reconnect reschedule', () => {
        const timers = createManualTimers();
        const retry = createSessionMessageCommitRetry<string, number>({
            maxAttempts: 2,
            resolveDelayMs: () => 1,
            scheduleTimer: timers.schedule,
            clearTimer: timers.clear,
        });
        const token = retry.beginIntent('same-local-id', 'revision-1');

        expect(retry.schedule(token, () => undefined)).toBe(true);
        timers.run(timers.latest().id);
        expect(retry.schedule(token, () => undefined)).toBe(true);
        timers.run(timers.latest().id);

        expect(retry.rescheduleCurrent('same-local-id', () => undefined)).toBe(false);
        expect(retry.readCurrent(token)?.attempts).toBe(2);
    });

    it('cancels every timer and rejects future work after disposal', () => {
        const timers = createManualTimers();
        const retry = createSessionMessageCommitRetry<string, number>({
            maxAttempts: 3,
            resolveDelayMs: () => 1,
            scheduleTimer: timers.schedule,
            clearTimer: timers.clear,
        });
        const token = retry.beginIntent('same-local-id', 'revision-1');
        retry.schedule(token, () => undefined);
        const timer = timers.latest();

        retry.dispose();

        expect(timers.wasCleared(timer.id)).toBe(true);
        expect(retry.size).toBe(0);
        expect(() => retry.beginIntent('same-local-id', 'revision-2')).toThrow(/disposed/i);
    });
});
