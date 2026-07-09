import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    buildFlashListChatListItems,
    createFlashListChatListWebScroller,
    renderFlashListChatListSession,
    resetFlashListChatListHarness,
    triggerFlashListChatListScroll,
    withFlashListChatListWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadNewerMessages = vi.fn(async (_sessionId?: string) => {});
const hasDeferredNewerMessages = vi.fn(() => true);
const getSyncTuning = vi.fn(() => ({ transcriptForwardPrefetchThresholdPx: 800, transcriptBackwardPrefetchThresholdPx: 0, transcriptLegendListSpikeSurface: 'flashList' }));
const maybeDrainDeferredNewerMessages = vi.fn();

installFlashListChatListCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
            platformOs: 'web',
        }),
});

vi.mock('@/components/sessions/chatListItems', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(buildFlashListChatListItems)
));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: () => React.createElement('MessageViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
        loadNewerMessages,
        hasDeferredNewerMessages,
        getSyncTuning,
        maybeDrainDeferredNewerMessages,
    }),
);

describe('ChatList (forward prefetch)', () => {
    beforeEach(() => {
        resetFlashListChatListHarness({
            platformOs: 'web',
        });

        loadNewerMessages.mockClear();
        hasDeferredNewerMessages.mockClear();
        hasDeferredNewerMessages.mockReturnValue(true);
        getSyncTuning.mockClear();
        getSyncTuning.mockReturnValue({ transcriptForwardPrefetchThresholdPx: 800, transcriptBackwardPrefetchThresholdPx: 0, transcriptLegendListSpikeSurface: 'flashList' });
        maybeDrainDeferredNewerMessages.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('routes unpinned near-bottom geometry to sync for deferred newer handling', async () => {
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 200,
        });
        await withFlashListChatListWebScrollerDom(scroller, async () => {
            await renderFlashListChatListSession();
            maybeDrainDeferredNewerMessages.mockClear();
            scroller.scrollTop = 200;
            await triggerFlashListChatListScroll(200);
        });

        expect(maybeDrainDeferredNewerMessages).toHaveBeenCalledWith('session-1', {
            isPinned: false,
            distanceFromBottomPx: 300,
        });
        expect(loadNewerMessages).not.toHaveBeenCalled();
    });

    it('delegates far-from-bottom geometry to sync instead of filtering by threshold locally', async () => {
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 0,
        });
        await withFlashListChatListWebScrollerDom(scroller, async () => {
            await renderFlashListChatListSession();
            maybeDrainDeferredNewerMessages.mockClear();
            scroller.scrollTop = 0;
            await triggerFlashListChatListScroll(0);
        });

        expect(maybeDrainDeferredNewerMessages).toHaveBeenCalledWith('session-1', {
            isPinned: false,
            distanceFromBottomPx: 500,
        });
        expect(loadNewerMessages).not.toHaveBeenCalled();
    });
});
