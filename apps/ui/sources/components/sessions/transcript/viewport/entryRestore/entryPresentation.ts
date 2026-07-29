export type EntryPresentationPlatform = 'native' | 'web';

export type EntryPresentationState = Readonly<{
    entryPhase: 'pending' | 'terminal';
    key: string | null;
    released: boolean;
    rendererPhase: 'idle' | 'started' | 'settled';
}>;

export type EntryPresentationEvent =
    | Readonly<{ type: 'entry-confirmed' }>
    | Readonly<{ type: 'entry-fallback' }>
    | Readonly<{ type: 'renderer-started' }>
    | Readonly<{ type: 'renderer-settled' }>
    | Readonly<{ type: 'renderer-fallback' }>;

export function createEntryPresentationKey(params: Readonly<{
    platform: EntryPresentationPlatform;
    sessionId: string;
}>): string {
    return `${params.platform}\0${params.sessionId}`;
}

export function createEntryPresentationState(key: string | null): EntryPresentationState {
    return {
        entryPhase: 'pending',
        key,
        released: key == null,
        rendererPhase: 'idle',
    };
}

/**
 * Presentation-only join for a detached keyed entry. Positioning remains owned by the
 * entry transaction and renderer held intent; this state only decides when their shared
 * landing may become visible.
 *
 * The join releases on an AFFIRMATIVE landing signal, never on a timeout. Two signals
 * qualify, and they are not interchangeable:
 * - `entry-confirmed`: the entry restore transaction closed on an observed ALIGNED reading
 *   of the live viewport against its target (`entryRestoreTransaction.onObservation`). The
 *   frame the reader would see is already at the anchor, so nothing later can move it to a
 *   position they never asked for — this is the terminal, whatever the renderer is doing.
 * - `renderer-settled` / `renderer-fallback`: the renderer's own placement finish. This is
 *   the only signal available when the app owner did NOT observe alignment
 *   (`entry-fallback`: deadline, preemption, or no target), so that path still waits for it.
 *
 * Requiring BOTH after a confirmed alignment made the renderer finish load-bearing for a
 * position the owner had already measured as correct; when the renderer never emits one, the
 * only remaining terminal is the first-paint placeholder deadline (live web repro,
 * 2026-07-29: `renderer-started` -> `entry-confirmed` +186ms -> no finish, transcript held
 * behind the placeholder for ~1.7s until `deadline-fallback`).
 */
export function reduceEntryPresentationState(
    state: EntryPresentationState,
    event: EntryPresentationEvent,
): EntryPresentationState {
    if (state.released) return state;
    switch (event.type) {
        case 'entry-confirmed':
            return { ...state, entryPhase: 'terminal', released: true };
        case 'entry-fallback':
            return {
                ...state,
                entryPhase: 'terminal',
                // The renderer starts synchronously with an entry-tagged command. If the app
                // owner finishes while no placement started, this entry needed no held
                // placement (for example the native write-free slice), so fail open. Once a
                // renderer placement started and the owner closed WITHOUT observing alignment,
                // the renderer's finish is the only remaining affirmative landing signal.
                released: state.rendererPhase === 'settled' || state.rendererPhase === 'idle',
            };
        case 'renderer-started':
            return { ...state, rendererPhase: 'started' };
        case 'renderer-settled':
        case 'renderer-fallback':
            // A finish without a matching start is stale or belongs to a predecessor
            // placement. The renderer contract always starts synchronously at the keyed
            // bootstrap/hold owner before it can finish.
            if (state.rendererPhase !== 'started') return state;
            return {
                ...state,
                released: state.entryPhase === 'terminal',
                rendererPhase: 'settled',
            };
    }
}
