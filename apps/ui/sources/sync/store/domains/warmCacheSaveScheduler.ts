export const WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS = 1_000;

type WarmCacheSaveSchedulerOptions<State, PreviousEntries> = Readonly<{
    get: () => State;
    save: (state: State, previousEntries?: PreviousEntries) => void;
    delayMs?: number;
    onSchedule?: (event: Readonly<{ state: State; coalesced: boolean }>) => void;
    onFlush?: (state: State, flush: () => void) => void;
}>;

export function createWarmCacheSaveScheduler<State, PreviousEntries = never>(
    options: WarmCacheSaveSchedulerOptions<State, PreviousEntries>,
): Readonly<{
    clear: () => void;
    saveImmediately: (state: State, previousEntries?: PreviousEntries) => void;
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
        saveImmediately: (state, previousEntries) => {
            clear();
            options.save(state, previousEntries);
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
