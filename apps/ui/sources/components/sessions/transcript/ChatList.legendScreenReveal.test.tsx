import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createReactNativeAppStateEmitter, standardCleanup } from '@/dev/testkit';
import {
    buildFlashListChatListItems,
    flashListChatListHarnessState,
    renderChatList,
    resetLegendChatListHarness,
    setChatListHarnessSessionScreenFocused,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const appStateBoundary = createReactNativeAppStateEmitter();

installFlashListChatListCommonModuleMocks({
    reactNative: async () => {
        const { createFlashListChatListReactNativeMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createFlashListChatListReactNativeMock({
            overrides: { AppState: appStateBoundary.appState },
        });
    },
});

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: buildFlashListChatListItems,
    buildChatListItemsCached: (options: Parameters<typeof buildFlashListChatListItems>[0]) => ({
        cache: null,
        items: buildFlashListChatListItems(options),
    }),
}));

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock()
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

describe('ChatList native screen-reveal viewport revalidation (S-E route-pop blank)', () => {
    beforeEach(() => {
        appStateBoundary.emit('active');
        resetLegendChatListHarness({ platformOs: 'ios' });
        flashListChatListHarnessState.sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'oldest', localId: null, createdAt: 1, text: 'first' },
                { kind: 'agent-text', id: 'newest', localId: null, createdAt: 2, text: 'second', isThinking: false },
            ],
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('re-observes the natively displayed offset when the session screen regains focus', async () => {
        // Live native S-E capture (2026-07-11): a tool-details route pop revealed the
        // transcript with Legend state desynced from the native scroll position and zero
        // scroll events to re-observe — a persistent blank window until the user's first
        // swipe. On focus-return the host must ask the renderer to revalidate the viewport
        // against the natively displayed offset.
        const { ChatList } = await import('./ChatList');
        const screen = await renderChatList(React.createElement(ChatList, {
            session: { ...flashListChatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });

        const legendRefHandle = flashListChatListHarnessState.legendListRefHandle as {
            scrollToOffset: ReturnType<typeof vi.fn>;
            getState: () => { scroll: number };
            getNativeScrollRef?: () => unknown;
        };
        const innerMeasure = vi.fn((onSuccess: (
            x: number,
            y: number,
            width: number,
            height: number,
            pageX: number,
            pageY: number,
        ) => void) => onSuccess(0, 0, 320, 2_000, 0, -120));
        const hostMeasure = vi.fn((onSuccess: (
            x: number,
            y: number,
            width: number,
            height: number,
            pageX: number,
            pageY: number,
        ) => void) => onSuccess(0, 0, 320, 800, 0, 80));
        const innerNode = { measure: innerMeasure };
        const hostNode = { measure: hostMeasure };
        legendRefHandle.getNativeScrollRef = () => ({
            getInnerViewRef: () => innerNode,
            getNativeScrollRef: () => hostNode,
        });
        legendRefHandle.scrollToOffset.mockClear();

        // Details route push (screen blurs), then pop (screen refocuses).
        await act(async () => {
            setChatListHarnessSessionScreenFocused(false);
        });
        expect(innerMeasure).not.toHaveBeenCalled();
        expect(hostMeasure).not.toHaveBeenCalled();
        await act(async () => {
            setChatListHarnessSessionScreenFocused(true);
        });

        expect(innerMeasure).toHaveBeenCalledTimes(1);
        expect(hostMeasure).toHaveBeenCalledTimes(1);
        expect(legendRefHandle.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 200,
        });

        await screen.unmount();
    });

    it('does not revalidate on the initial focused mount', async () => {
        const { ChatList } = await import('./ChatList');
        const screen = await renderChatList(React.createElement(ChatList, {
            session: { ...flashListChatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });

        const legendRefHandle = flashListChatListHarnessState.legendListRefHandle as {
            getNativeScrollRef?: () => unknown;
        };
        const innerMeasure = vi.fn();
        const hostMeasure = vi.fn();
        const innerNode = { measure: innerMeasure };
        const hostNode = { measure: hostMeasure };
        legendRefHandle.getNativeScrollRef = () => ({
            getInnerViewRef: () => innerNode,
            getNativeScrollRef: () => hostNode,
        });

        // Re-assert focus without a preceding blur: no reveal transition, no revalidation.
        await act(async () => {
            setChatListHarnessSessionScreenFocused(true);
        });

        expect(innerMeasure).not.toHaveBeenCalled();
        expect(hostMeasure).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('re-observes the native displayed offset once when AppState resumes without a navigation blur', async () => {
        const { ChatList } = await import('./ChatList');
        const screen = await renderChatList(React.createElement(ChatList, {
            session: { ...flashListChatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });

        const legendRefHandle = flashListChatListHarnessState.legendListRefHandle as {
            scrollToOffset: ReturnType<typeof vi.fn>;
            getState: () => { scroll: number };
            getNativeScrollRef?: () => unknown;
        };
        const innerMeasure = vi.fn((onSuccess: (
            x: number,
            y: number,
            width: number,
            height: number,
            pageX: number,
            pageY: number,
        ) => void) => onSuccess(0, 0, 320, 2_000, 0, -120));
        const hostMeasure = vi.fn((onSuccess: (
            x: number,
            y: number,
            width: number,
            height: number,
            pageX: number,
            pageY: number,
        ) => void) => onSuccess(0, 0, 320, 800, 0, 80));
        const innerNode = { measure: innerMeasure };
        const hostNode = { measure: hostMeasure };
        legendRefHandle.getNativeScrollRef = () => ({
            getInnerViewRef: () => innerNode,
            getNativeScrollRef: () => hostNode,
        });
        legendRefHandle.scrollToOffset.mockClear();
        expect(appStateBoundary.getListenerCount()).toBe(1);

        appStateBoundary.emit('active');
        appStateBoundary.emit('inactive');
        appStateBoundary.emit('background');
        appStateBoundary.emit('active');
        appStateBoundary.emit('active');

        expect(innerMeasure).toHaveBeenCalledTimes(1);
        expect(hostMeasure).toHaveBeenCalledTimes(1);
        expect(legendRefHandle.scrollToOffset).toHaveBeenCalledExactlyOnceWith({
            animated: false,
            offset: 200,
        });

        await screen.unmount();
    });

    it('does not revalidate from AppState lifecycle events on web', async () => {
        resetLegendChatListHarness({ platformOs: 'web' });
        const { ChatList } = await import('./ChatList');
        const screen = await renderChatList(React.createElement(ChatList, {
            session: { ...flashListChatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });

        const legendRefHandle = flashListChatListHarnessState.legendListRefHandle as {
            getNativeScrollRef?: () => unknown;
        };
        const innerMeasure = vi.fn();
        const hostMeasure = vi.fn();
        const innerNode = { measure: innerMeasure };
        const hostNode = { measure: hostMeasure };
        legendRefHandle.getNativeScrollRef = () => ({
            getInnerViewRef: () => innerNode,
            getNativeScrollRef: () => hostNode,
        });

        appStateBoundary.emit('inactive');
        appStateBoundary.emit('background');
        appStateBoundary.emit('active');

        expect(appStateBoundary.getListenerCount()).toBe(0);
        expect(innerMeasure).not.toHaveBeenCalled();
        expect(hostMeasure).not.toHaveBeenCalled();

        await screen.unmount();
    });
});
