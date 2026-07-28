import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFlashListChatListWebScroller,
  flashListChatListHarnessState,
  renderFlashListChatList,
  resetFlashListChatListHarness,
  standardCleanup,
  withFlashListChatListWebScrollerDom,
} from '@/dev/testkit';
import {
  installTranscriptCommonModuleMocks,
  resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
      platformOs: 'web',
    }),
  storage: async (importOriginal) =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal),
});

beforeEach(() => {
  resetTranscriptCommonModuleMockState();
  resetFlashListChatListHarness({ platformOs: 'web' });
  flashListChatListHarnessState.sessionMessagesState = {
    messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
    isLoaded: true,
  };
  flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
  flashListChatListHarnessState.sessionActionDraftsState = [];
  // Use sessionSeq=0 to avoid triggering the initial-fill effect (pins unconditionally).
  flashListChatListHarnessState.sessionState = {
    ...flashListChatListHarnessState.sessionState,
    id: 'session-1',
    seq: 0,
    metadata: null,
    accessLevel: null,
    canApprovePermissions: true,
  };
});

afterEach(() => {
  resetTranscriptCommonModuleMockState();
  standardCleanup();
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/chatListItems', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock((opts: any) => {
    if (opts?.includeCommittedMessages === false) return [];
    return (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
      const message = opts?.messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: null };
    });
  })
);

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
  MessageViewWithSessionCommon: () => React.createElement('MessageViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
  PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
  SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
  TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
  TranscriptMotionProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
  resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
  JumpToBottomButton: () => null,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
  getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
    loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
    loadNewerMessages: vi.fn(),
  })
);

describe('ChatList (FlashList v2, web) scroll pin intent without wheel events', () => {
  it('splits oversized grouped turns into virtualizable rows on web', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    flashListChatListHarnessState.syncTuningState = {
      ...flashListChatListHarnessState.syncTuningState,
      transcriptMaxTurnEntriesPerListItem: 3,
    };
    flashListChatListHarnessState.sessionMessagesState = {
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'a1' },
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, seq: 3, text: 'a2' },
        { kind: 'agent-text', id: 'a3', localId: null, createdAt: 4, seq: 4, text: 'a3' },
        { kind: 'agent-text', id: 'a4', localId: null, createdAt: 5, seq: 5, text: 'a4' },
      ],
      isLoaded: true,
    };

    await withFlashListChatListWebScrollerDom({ scrollHeight: 1200, clientHeight: 500, scrollTop: 700, isConnected: true }, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      const capturedProps = screen.requireCapturedFlashListProps();
      const data = capturedProps.data;
      const hotItems = capturedProps.ListFooterComponent?.props?.hotItems ?? [];
      const virtualizedItems = [...data, ...hotItems];
      expect(virtualizedItems.map((item: any) => item.kind)).toEqual(['message', 'message', 'message', 'message', 'message']);
      expect(virtualizedItems.map((item: any) => item.messageId)).toEqual(['u1', 'a1', 'a2', 'a3', 'a4']);
    });
  });

  it('does not auto-repin on content size change after a large scroll away from bottom (scrollbar drag scenario)', async () => {
    // Set up transcript settings.
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl = createFlashListChatListWebScroller({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500, // bottom (2000 - 500)
    });

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      // Provide layout + content size so distance-from-bottom calculations work.
      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });

      // Simulate an initial pinned scroll event (at bottom).
      await screen.triggerScroll(1500);

      // Scrollbar drags begin with a pointer interaction on web (no wheel handler invoked).
      await screen.triggerPointerDown();

      // Simulate a large scroll away from bottom via scrollbar drag (no wheel handler invoked).
      scrollerEl.scrollTop = 1000;
      await screen.triggerScroll(1000);

      const scrollTopAfterUnpin = scrollerEl.scrollTop;

      // Content grows while user is away from bottom. We should NOT pin back to bottom.
      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      expect(scrollerEl.scrollTop).toBe(scrollTopAfterUnpin);
    });
  });

  it('keeps the pin for sustained non-programmatic upward movement without recent user intent', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl = createFlashListChatListWebScroller({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500, // bottom (2000 - 500)
    });

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });

      // Establish the bottom baseline.
      await screen.triggerScroll(1500);

      // Scrollbar drag / keyboard scroll: two consecutive non-trusted upward frames with
      // NO wheel/pointer/touch handler involvement, both still within the pin threshold.
      scrollerEl.scrollTop = 1460;
      await screen.triggerScroll(1460);
      scrollerEl.scrollTop = 1430;
      await screen.triggerScroll(1430);

      // Content grows. Without wheel/pointer/touch intent, passive upward churn alone no
      // longer owns release authority, so the viewport stays pinned to the live tail.
      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      expect(scrollerEl.scrollTop).toBe(1900);
    });
  });

  it('keeps the pin through a single upward height-churn frame within the threshold', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl = createFlashListChatListWebScroller({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500,
    });

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });
      await screen.triggerScroll(1500);

      // A single isolated upward frame within the threshold (virtualization noise) must not
      // unpin: bottom-follow growth keeps pinning to the bottom.
      scrollerEl.scrollTop = 1470;
      await screen.triggerScroll(1470);

      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      // Still following: passive churn does not steal release authority from pinned follow mode.
      expect(scrollerEl.scrollTop).toBe(1900);
    });
  });

  it('keeps the pin through repeated upward height-churn frames while web content height changes', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl = createFlashListChatListWebScroller({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500,
    });

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });
      await screen.triggerScroll(1500);

      // Streaming/recycling churn can report repeated small upward scrollTop deltas while
      // the underlying content height is also changing. That must not be interpreted as
      // sustained scrollbar/keyboard intent to unpin.
      scrollerEl.scrollHeight = 2010;
      scrollerEl.scrollTop = 1495;
      await screen.triggerScroll(1495);

      scrollerEl.scrollHeight = 2020;
      scrollerEl.scrollTop = 1490;
      await screen.triggerScroll(1490);

      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      // Still following: repeated passive churn still lacks release authority without user intent.
      expect(scrollerEl.scrollTop).toBe(1900);
    });
  });

  it('keeps the pin when the app own pin write UNDER-SHOOTS during streaming and RN-web marks it isTrusted (Q1-WEB-1)', async () => {
    // The Q1-WEB-1 regression: RN-web fires `isTrusted:true` for the app's OWN programmatic `scrollTop=` pin
    // write. When that write under-shoots the growing bottom mid-stream it is NOT an exact self-write match, so
    // the only thing keeping a pinned reader from falsely releasing is that web release authority now reads the
    // genuine-movement signal (self-write + churn excluded) instead of the event's isTrusted flag.
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl = createFlashListChatListWebScroller({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500,
    });

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });
      await screen.triggerScroll(1500);

      // Content grows; the app's own pin write lands a few px short of the new bottom and the resulting
      // scroll event is isTrusted. It must NOT be read as a genuine user scroll-up.
      scrollerEl.scrollHeight = 2010;
      scrollerEl.scrollTop = 1495; // under-shot the new max (1510)
      await screen.triggerScroll(1495, { isTrusted: true });

      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      // Still following: bottom-follow moved the viewport toward the new bottom rather than parking it at
      // the under-shoot offset (which is what a false release would do).
      expect(scrollerEl.scrollTop).toBeGreaterThan(1495);
    });
  });

  it('bounds FlashList rerenders while scroll distance remains below the jump-to-bottom reveal threshold', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomRevealViewportRatio = 0.5;

    const scrollerEl = createFlashListChatListWebScroller({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500,
    });

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });
      await screen.triggerScroll(1500);
      await screen.triggerPointerDown();

      scrollerEl.scrollTop = 1380;
      await screen.triggerScroll(1380);
      const rendersAfterFirstHiddenDistance = flashListChatListHarnessState.flashListRenderCount;

      scrollerEl.scrollTop = 1370;
      await screen.triggerScroll(1370);
      scrollerEl.scrollTop = 1360;
      await screen.triggerScroll(1360);

      expect(flashListChatListHarnessState.flashListRenderCount).toBeLessThanOrEqual(
        rendersAfterFirstHiddenDistance + 1,
      );
      const rendersAfterScrollPinTransition = flashListChatListHarnessState.flashListRenderCount;

      scrollerEl.scrollTop = 1350;
      await screen.triggerScroll(1350);
      scrollerEl.scrollTop = 1340;
      await screen.triggerScroll(1340);

      expect(flashListChatListHarnessState.flashListRenderCount).toBe(rendersAfterScrollPinTransition);
    });
  });

  it('treats trusted scroll events as user intent so a small scroll away from bottom does not get re-pinned during initial stabilization', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl = createFlashListChatListWebScroller({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500, // bottom (2000 - 500)
    });

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });

      // Start at bottom.
      await screen.triggerScroll(1500, { isTrusted: true });

      // User scrolls up slightly (within the pinned threshold), without wheel/pointer events.
      scrollerEl.scrollTop = 1480;
      await screen.triggerScroll(1480, { isTrusted: true });
      const scrollTopAfterSmallScroll = scrollerEl.scrollTop;

      // Content grows. If we incorrectly consider this still "pinned", we would snap back to bottom.
      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      expect(scrollerEl.scrollTop).toBe(scrollTopAfterSmallScroll);
    });
  });
});
