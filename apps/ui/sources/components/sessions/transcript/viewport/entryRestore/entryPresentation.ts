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
 */
export function reduceEntryPresentationState(
    state: EntryPresentationState,
    event: EntryPresentationEvent,
): EntryPresentationState {
    if (state.released) return state;
    switch (event.type) {
        case 'entry-confirmed':
        case 'entry-fallback':
            return {
                ...state,
                entryPhase: 'terminal',
                // The renderer starts synchronously with an entry-tagged command. If the app
                // owner finishes while no placement started, this entry needed no held
                // placement (for example the native write-free slice), so fail open. Once a
                // renderer placement starts, either app outcome waits for renderer settlement.
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
