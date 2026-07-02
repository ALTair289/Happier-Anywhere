import * as React from 'react';

/**
 * Keeps render-facing session-list inputs stable while the list surface is not data-active.
 *
 * A retained list should preserve the last active snapshot instead of deriving heavy row,
 * reachability, and virtualization state for updates that cannot be displayed yet.
 * When the surface becomes active again, the latest live value is adopted immediately.
 */
export function useSessionListSnapshotWhenInactive<T>(value: T, dataActive: boolean): T {
    const activeValueRef = React.useRef(value);

    React.useLayoutEffect(() => {
        if (dataActive) {
            activeValueRef.current = value;
        }
    }, [dataActive, value]);

    return dataActive ? value : activeValueRef.current;
}
