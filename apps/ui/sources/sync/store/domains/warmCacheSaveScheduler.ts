export const WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS = 1_000;

type WarmCacheSaveSchedulerOptions<State> = Readonly<{
    get: () => State;
    save: (state: State) => void;
    delayMs?: number;
    onSchedule?: (event: Readonly<{ state: State; coalesced: boolean }>) => void;
    onFlush?: (state: State, flush: () => void) => void;
}>;

/**
 * The save owner diffs against the persisted warm-cache baseline, so the scheduler never
 * carries a "previous entries" projection of its own.
 */
export function createWarmCacheSaveScheduler<State>(
    options: WarmCacheSaveSchedulerOptions<State>,
): Readonly<{
    clear: () => void;
    saveImmediately: (state: State) => void;
    schedule: (stateForTelemetry?: State) => void;
}> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const delayMs = options.delayMs ?? WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS;

    const clear = (): void => {
        if (!timeout) return;
        clearTimeout(timeout);
        timeout = null;
    };

    return {
        clear,
        saveImmediately: (state) => {
            clear();
            options.save(state);
        },
        schedule: (stateForTelemetry) => {
            const state = stateForTelemetry ?? options.get();
            if (timeout) {
                options.onSchedule?.({ state, coalesced: true });
                return;
            }

            options.onSchedule?.({ state, coalesced: false });
            timeout = setTimeout(() => {
                timeout = null;
                const currentState = options.get();
                const flush = () => {
                    options.save(currentState);
                };
                if (options.onFlush) {
                    options.onFlush(currentState, flush);
                } else {
                    flush();
                }
            }, delayMs);
        },
    };
}
