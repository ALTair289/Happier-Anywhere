import { describe, expect, it } from 'vitest';

import { resolveRowLayoutMutationViewportOwnershipAction } from './rowLayoutMutationViewportOwnership';

describe('resolveRowLayoutMutationViewportOwnershipAction', () => {
    // Live native S-C continuation (2026-07-11): the tool ROW inline expand/collapse
    // (ToolTimelineRow -> TranscriptCollapsible) commits a giant in-viewport height change
    // WITHOUT passing the group-toggle choke point, so under renderer-owned local height
    // restore (default Legend) no visible-anchor hold was armed and the expansion parked the
    // viewport hours away (offset 5559 -> 2590, firstVisibleItemId changed, zero writer
    // events). Every renderer-owned expand/collapse row mutation must arm the ONE keyed hold.
    it('arms the renderer hold for renderer-owned expand and collapse mutations', () => {
        expect(resolveRowLayoutMutationViewportOwnershipAction({
            localHeightChangeRestoreOwner: 'renderer',
            reason: 'expand',
        })).toBe('arm-visible-anchor-hold');
        expect(resolveRowLayoutMutationViewportOwnershipAction({
            localHeightChangeRestoreOwner: 'renderer',
            reason: 'collapse',
        })).toBe('arm-visible-anchor-hold');
    });

    it('never arms for app-owned restore (FlashList) or non-toggle signature changes', () => {
        expect(resolveRowLayoutMutationViewportOwnershipAction({
            localHeightChangeRestoreOwner: 'app',
            reason: 'expand',
        })).toBe('none');
        expect(resolveRowLayoutMutationViewportOwnershipAction({
            localHeightChangeRestoreOwner: 'renderer',
            reason: 'signature-change',
        })).toBe('none');
    });
});
