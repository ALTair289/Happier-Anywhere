import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
  buildFlashListChatListItems,
  flashListChatListHarnessState,
  renderFlashListChatListSession,
  resetFlashListChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import {
  clearSessionUiTelemetryMarks,
  markStreamingMessagesAppliedForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetSpy = vi.fn();
const scrollToIndexSpy = vi.fn();

installFlashListChatListCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
      platformOs: 'ios',
    }),
});

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: buildFlashListChatListItems,
  buildChatListItemsCached: (opts: any) => ({
    cache: null,
    items: buildFlashListChatListItems(opts),
  }),
}));

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
    hasDeferredNewerMessages: () => false,
  }),
);

const chatListModulePromise = import('./ChatList');

describe('ChatList (auto-follow while pinned)', () => {
  beforeEach(() => {
    resetFlashListChatListHarness({
      platformOs: 'ios',
      flashListRefHandle: {
        scrollToOffset: scrollToOffsetSpy,
        scrollToIndex: scrollToIndexSpy,
      },
      syncTuningState: {
        transcriptForwardPrefetchThresholdPx: 0,
        transcriptBackwardPrefetchThresholdPx: 0,
        transcriptFlashListEstimatedItemSize: 120,
        transcriptWebHotTailItemCount: 2,
        transcriptWebInitialPinStabilizeMs: 0,
        transcriptWebInitialPinRetryIntervalMs: 16,
      },
    });
    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();

    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
  });

  afterEach(() => {
    clearSessionUiTelemetryMarks();
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
    standardCleanup();
  });

  it('keeps native FlashList bottom maintenance as the follow owner when pinned activity arrives', async () => {
    const { ChatList } = await chatListModulePromise;
    (globalThis as any).requestAnimationFrame = (cb: any) => {
      cb(0);
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const screen = await renderFlashListChatListSession();

    scrollToOffsetSpy.mockClear();

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...flashListChatListHarnessState.sessionMessagesState.messages,
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' },
      ],
    };

    await act(async () => {
      // The harness mutates hook-backed message state directly; use a real render key to
      // simulate the store subscription re-render that production receives from storage.
      await screen.update(
        <ChatList session={{ ...flashListChatListHarnessState.sessionState }} followBottomIntentKey="activity-a2" />,
      );
    });
    await screen.settle();

    expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
    });
    expect(scrollToOffsetSpy.mock.calls.length + scrollToIndexSpy.mock.calls.length).toBe(0);
  });

  it('records visible streaming update telemetry when a marked socket message reaches the transcript', async () => {
    const { ChatList } = await chatListModulePromise;
    syncPerformanceTelemetry.configure({
      enabled: true,
      slowThresholdMs: 1_000_000,
      flushIntervalMs: 60_000,
    });
    syncPerformanceTelemetry.reset();

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      ],
    };

    const screen = await renderFlashListChatListSession();

    markStreamingMessagesAppliedForSessionUiTelemetry({
      sessionId: flashListChatListHarnessState.sessionState.id,
      source: 'socketMessage',
      messages: [
        { id: 'a1' },
      ],
    });

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...flashListChatListHarnessState.sessionMessagesState.messages,
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    await act(async () => {
      // See above: force the memoized ChatList to observe the mutated hook-backed snapshot.
      await screen.update(
        <ChatList session={{ ...flashListChatListHarnessState.sessionState }} followBottomIntentKey="streaming-visible-a1" />,
      );
    });
    await screen.settle();

    const event = syncPerformanceTelemetry
      .snapshot()
      .events.find((candidate) => candidate.name === 'ui.sessions.streaming.visibleUpdate');

    expect(event).toBeTruthy();
    expect(event?.fields).toMatchObject({
      sourceSocketMessage: 1,
      sourceTranscriptStreamSegment: 0,
      committedMessages: 2,
    });
    expect(Object.values(event?.fields ?? {}).every((value) => typeof value === 'number')).toBe(true);
  });
});
