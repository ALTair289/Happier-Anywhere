import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storage';

import {
    createLocalActivityBadgeSnapshotSelector,
    type LocalActivityBadgeSnapshotSelectorParams,
    type LocalActivityBadgeSnapshot,
} from './createLocalActivityBadgeSnapshotSelector';

/**
 * Subscribes to the derived badge snapshot rather than to the raw session records
 * it is derived from. The selector returns a stable instance while the badge is
 * unchanged, so an unrelated store apply costs one selector call and no render.
 */
export function useLocalActivityBadgeSnapshot(
    params: LocalActivityBadgeSnapshotSelectorParams,
): LocalActivityBadgeSnapshot {
    const selector = React.useMemo(() => createLocalActivityBadgeSnapshotSelector(params), [
        params.badgesEnabled,
        params.friendRequestCount,
        params.hasNonNumericInboxAttention,
        params.sessionOptions,
    ]);
    return getStorage()(selector);
}
