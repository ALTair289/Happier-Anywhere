export type PermissionActionDispatchGuard = Readonly<{
    setRequestKey: (requestKey: string) => void;
    retainRequest: (requestKey: string) => void;
    releaseRequest: (requestKey: string) => void;
    dispatch: (requestKey: string, action: () => Promise<void>) => Promise<boolean>;
}>;

type GuardState = {
    requestKey: string;
    phase: 'idle' | 'in_flight' | 'settled';
};

type SharedRequestState = {
    retainedBy: Set<object>;
    inFlightToken: object | null;
    settled: boolean;
};

// A permission can be visible in more than one surface at once (for example the
// session transcript and inbox attention view). Component-local state prevents
// double taps in one footer, while this registry arbitrates independently mounted
// footer instances. A successful request remains settled until every mounted
// pending surface releases it, covering the gap before transcript state arrives.
const sharedRequests = new Map<string, SharedRequestState>();

function getOrCreateSharedRequest(requestKey: string): SharedRequestState {
    const existing = sharedRequests.get(requestKey);
    if (existing) return existing;

    const created: SharedRequestState = {
        retainedBy: new Set(),
        inFlightToken: null,
        settled: false,
    };
    sharedRequests.set(requestKey, created);
    return created;
}

function removeUnretainedRequest(requestKey: string, sharedRequest: SharedRequestState): void {
    if (sharedRequest.retainedBy.size === 0 && sharedRequest.inFlightToken === null) {
        sharedRequests.delete(requestKey);
    }
}

export function createPermissionActionDispatchGuard(initialRequestKey: string): PermissionActionDispatchGuard {
    const ownerToken = {};
    const state: GuardState = {
        requestKey: initialRequestKey,
        phase: 'idle',
    };

    const setRequestKey = (requestKey: string) => {
        if (state.requestKey === requestKey) return;
        state.requestKey = requestKey;
        state.phase = 'idle';
    };

    return {
        setRequestKey,
        retainRequest(requestKey) {
            getOrCreateSharedRequest(requestKey).retainedBy.add(ownerToken);
        },
        releaseRequest(requestKey) {
            const sharedRequest = sharedRequests.get(requestKey);
            if (!sharedRequest) return;
            sharedRequest.retainedBy.delete(ownerToken);
            removeUnretainedRequest(requestKey, sharedRequest);
        },
        async dispatch(requestKey, action) {
            setRequestKey(requestKey);
            if (state.phase !== 'idle') return false;
            const sharedRequest = getOrCreateSharedRequest(requestKey);
            if (sharedRequest.inFlightToken !== null || sharedRequest.settled) return false;

            const dispatchToken = {};
            sharedRequest.inFlightToken = dispatchToken;
            state.phase = 'in_flight';
            try {
                await action();
                sharedRequest.settled = true;
                if (state.requestKey === requestKey) {
                    state.phase = 'settled';
                }
                return true;
            } catch (error) {
                sharedRequest.settled = false;
                if (state.requestKey === requestKey) {
                    state.phase = 'idle';
                }
                throw error;
            } finally {
                if (sharedRequest.inFlightToken === dispatchToken) {
                    sharedRequest.inFlightToken = null;
                }
                removeUnretainedRequest(requestKey, sharedRequest);
            }
        },
    };
}
