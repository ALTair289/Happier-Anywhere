import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  flashListChatListHarnessState,
  renderFlashListChatList,
  resetFlashListChatListHarness,
  standardCleanup,
} from '@/dev/testkit';
import { transcriptViewportTelemetry } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
  installTranscriptCommonModuleMocks,
  resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Plan G4 performance guard (§5 G4, §7 perf constraints): the transcript scroll path must stay
 * ref-based — scroll frames that cross no UI-state threshold must produce ZERO additional React
 * commits of the ChatList subtree. Commits are counted through the EXISTING
 * SyncPerformanceReactProfiler infrastructure (ChatList wraps itself in
 * `<SyncPerformanceReactProfiler id="sessions.transcript.chatList">`; every commit records a
 * `ui.react.render.sessions.transcript.chatList` event when syncPerformanceTelemetry is enabled).
 * Viewport telemetry is deliberately ENABLED too (FW5 handoff: guard must hold with telemetry on).
 */

const scrollToOffsetSpy = vi.fn();
let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

const CHAT_LIST_RENDER_EVENT = 'ui.react.render.sessions.transcript.chatList';

function readChatListCommitCount(): number {
  const event = syncPerformanceTelemetry
    .snapshot()
    .events.find((candidate) => candidate.name === CHAT_LIST_RENDER_EVENT);
  return event?.count ?? 0;
}

installTranscriptCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
      platformOs: 'ios',
    }),
  storage: async (importOriginal) =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal),
});

beforeEach(() => {
  vi.useFakeTimers();
  resetTranscriptCommonModuleMockState();
  previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  scrollToOffsetSpy.mockClear();
  syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 60_000, flushIntervalMs: 600_000 });
  syncPerformanceTelemetry.reset();
  transcriptViewportTelemetry.configure({ enabled: true, capacity: 500 });
  resetFlashListChatListHarness({
    flashListRefHandle: { scrollToOffset: scrollToOffsetSpy, scrollToIndex: vi.fn() },
    platformOs: 'ios',
  });
  flashListChatListHarnessState.sessionMessagesState = {
    messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
    isLoaded: true,
  };
  flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
  flashListChatListHarnessState.sessionActionDraftsState = [];
  // sessionSeq=0 avoids the initial-fill effect's unconditional pin (matches sibling suites).
  flashListChatListHarnessState.sessionState = {
    ...flashListChatListHarnessState.sessionState,
    id: 'session-1',
    seq: 0,
    metadata: null,
    accessLevel: null,
    canApprovePermissions: true,
  };
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useHeaderHeight: () => 0,
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/chatListItems', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(({ messageIdsOldestFirst, messagesById }: any) =>
    (messageIdsOldestFirst ?? []).map((id: string) => {
      const message = messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: null };
    }),
  )
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

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
  ComposerKeyboardScrollInset: (props: { testID?: string }) => React.createElement('ComposerKeyboardScrollInset', props),
  ComposerKeyboardFloatingInset: ({ children }: { children: React.ReactNode }) =>
    React.createElement('ComposerKeyboardFloatingInset', null, children),
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
    loadOlderMessages: vi.fn(),
    loadNewerMessages: vi.fn(),
  })
);

describe('ChatList (FlashList v2 scroll-path render guard, plan G4)', () => {
  afterEach(() => {
    transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
    globalThis.requestAnimationFrame = previousRequestAnimationFrame as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame as typeof globalThis.cancelAnimationFrame;
    vi.useRealTimers();
    resetTranscriptCommonModuleMockState();
    standardCleanup();
  });

  it('records ChatList commits through the SyncPerformanceReactProfiler (guard sensitivity check)', async () => {
    const { ChatList } = await import('./ChatList');

    const screen = await renderFlashListChatList(
      <ChatList session={flashListChatListHarnessState.sessionState} />
    );
    expect(screen.getCapturedFlashListProps()).toBeTruthy();
    await screen.triggerInitialFill({ layoutHeight: 600, contentHeight: 3000, contentWidth: 0 });

    // The mount itself must be observable, otherwise the zero-commit assertion below would be
    // vacuously green (a disabled/mis-wired profiler would also report zero).
    expect(readChatListCommitCount()).toBeGreaterThan(0);
  });

  it('issues zero additional React commits for steady mid-list scroll frames (scroll path stays ref-based)', async () => {
    const { ChatList } = await import('./ChatList');

    const screen = await renderFlashListChatList(
      <ChatList session={flashListChatListHarnessState.sessionState} />
    );
    expect(screen.getCapturedFlashListProps()).toBeTruthy();
    await screen.triggerInitialFill({ layoutHeight: 600, contentHeight: 3000, contentWidth: 0 });
    await screen.triggerLoad(12, { turns: 1 });
    await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

    const scrollExtras = {
      contentSize: { height: 3000, width: 0 },
      layoutMeasurement: { height: 600, width: 0 },
      isTrusted: true,
    } as const;

    // One trusted escape scroll away from the bottom: pin/jump-button state transitions are
    // legitimate React commits and may happen HERE (not per frame). Warm through the full
    // mid-list offset range once so any one-time distance-bucket state settles, then baseline.
    await screen.triggerScroll(1200, { ...scrollExtras });
    await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
    await screen.triggerScroll(1000, { ...scrollExtras });
    await screen.triggerScroll(1180, { ...scrollExtras });
    await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

    const baselineCommits = readChatListCommitCount();

    // 12 steady mid-list frames: all unpinned, far from both the pin threshold (bottom) and the
    // top-pagination threshold; no UI-state boundary is crossed, so the scroll path must commit
    // NOTHING (per-frame work stays in refs — plan §7, invariant E adjacency).
    const midListOffsets = [1180, 1150, 1120, 1090, 1060, 1030, 1000, 1030, 1060, 1090, 1120, 1150];
    for (const offsetY of midListOffsets) {
      await screen.triggerScroll(offsetY, { ...scrollExtras });
    }

    const commitsAfterScrolls = readChatListCommitCount();
    expect(
      commitsAfterScrolls - baselineCommits,
      `scroll path regression: ${commitsAfterScrolls - baselineCommits} React commit(s) during `
      + `${midListOffsets.length} steady scroll frames (expected 0 — per-frame setState on the scroll path)`,
    ).toBe(0);
  });

  it('keeps FlashList data identity stable when session activity changes without changing the live-tail anchor', async () => {
    const { ChatList } = await import('./ChatList');
    flashListChatListHarnessState.sessionMessagesState = {
      messages: [
        { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, seq: 1, text: 'hi' },
        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'there' },
      ],
      isLoaded: true,
    };

    const inactiveSession = {
      ...flashListChatListHarnessState.sessionState,
      active: false,
      thinking: false,
    };
    const screen = await renderFlashListChatList(
      <ChatList session={inactiveSession} />
    );
    await screen.triggerInitialFill({ layoutHeight: 600, contentHeight: 3000, contentWidth: 0 });
    await screen.settle({ cycles: 1, turns: 1 });

    const initialData = screen.requireCapturedFlashListProps().data;
    const baselineCommits = readChatListCommitCount();

    await screen.update(
      <ChatList
        session={{
          ...inactiveSession,
          active: true,
        }}
      />
    );
    await screen.settle({ cycles: 1, turns: 1 });

    expect(readChatListCommitCount()).toBeGreaterThan(baselineCommits);
    expect(screen.requireCapturedFlashListProps().data).toBe(initialData);
  });
});
