import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';
import {
    awaitTranscriptNavigationJumpHandler,
    createEmptyTranscriptNavigationPaneSnapshot,
    createTranscriptNavigationPaneStore,
    transcriptNavigationPaneStore,
} from './transcriptNavigationPaneStore';

function entry(overrides: Partial<TranscriptNavigationEntry> & Pick<TranscriptNavigationEntry, 'id' | 'sessionId' | 'seq'>): TranscriptNavigationEntry {
    const { id, sessionId, seq, ...rest } = overrides;
    return {
        id,
        sessionId,
        seq,
        routeMessageId: null,
        transcriptBlockIndex: null,
        kind: 'user-turn',
        role: 'user',
        label: id,
        promptPreview: id,
        responsePreview: null,
        createdAtMs: null,
        pinned: false,
        pinnedAtMs: null,
        loaded: true,
        ...rest,
    };
}

describe('transcript navigation pane store', () => {
    it('starts with an empty per-session snapshot', () => {
        const store = createTranscriptNavigationPaneStore();

        expect(store.get('s1')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s1'));
        expect(store.get('s1')).toBe(store.get('s1'));
    });

    it('notifies subscribers when a session snapshot changes and resets on null', () => {
        const store = createTranscriptNavigationPaneStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe('s1', listener);
        const entries = [entry({ id: 'turn-1', sessionId: 's1', seq: 1 })];
        const onEntryPress = vi.fn();

        store.set('s1', {
            activeEntryId: 'turn-1',
            entries,
            onEntryPress,
        });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.get('s1')).toMatchObject({
            activeEntryId: 'turn-1',
            entries,
            sessionId: 's1',
        });
        expect(store.get('s1').onEntryPress).toBe(onEntryPress);

        store.set('s1', null);

        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.get('s1')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s1'));

        unsubscribe();
        store.set('s1', {
            activeEntryId: null,
            entries,
            onEntryPress,
        });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('keeps session snapshots isolated', () => {
        const store = createTranscriptNavigationPaneStore();
        const s1Listener = vi.fn();
        const s2Listener = vi.fn();
        const entries = [entry({ id: 'turn-1', sessionId: 's1', seq: 1 })];

        store.subscribe('s1', s1Listener);
        store.subscribe('s2', s2Listener);

        store.set('s1', {
            activeEntryId: null,
            entries,
            onEntryPress: vi.fn(),
        });

        expect(s1Listener).toHaveBeenCalledTimes(1);
        expect(s2Listener).not.toHaveBeenCalled();
        expect(store.get('s2')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s2'));
    });
});

describe('awaitTranscriptNavigationJumpHandler', () => {
    afterEach(() => {
        transcriptNavigationPaneStore.set('await-session', null);
    });

    it('resolves with the handler a host publishes AFTER the press, never before the reveal commits', async () => {
        const entries = [entry({ id: 'turn-1', sessionId: 'await-session', seq: 1 })];
        const onEntryPress = vi.fn();
        let observedHandlerWhileWaiting: unknown = 'unobserved';

        // No host registered yet: this is the phone-cockpit case, where the chat
        // scene is frozen and React has torn its layout effects down.
        const pending = awaitTranscriptNavigationJumpHandler('await-session', { timeoutMs: 2_000 });
        pending.then((handler) => {
            observedHandlerWhileWaiting = handler;
        });

        await Promise.resolve();
        expect(observedHandlerWhileWaiting).toBe('unobserved');

        transcriptNavigationPaneStore.set('await-session', {
            activeEntryId: null,
            entries,
            onEntryPress,
        });

        await expect(pending).resolves.toBe(onEntryPress);
    });

    it('yields a task before handing back an already-registered handler', async () => {
        const onEntryPress = vi.fn();
        transcriptNavigationPaneStore.set('await-session', {
            activeEntryId: null,
            entries: [entry({ id: 'turn-1', sessionId: 'await-session', seq: 1 })],
            onEntryPress,
        });

        let settled = false;
        const pending = awaitTranscriptNavigationJumpHandler('await-session').then((handler) => {
            settled = true;
            return handler;
        });

        await Promise.resolve();
        expect(settled).toBe(false);

        await expect(pending).resolves.toBe(onEntryPress);
    });

    it('resolves null once the wait budget elapses with no host', async () => {
        vi.useFakeTimers();
        try {
            const pending = awaitTranscriptNavigationJumpHandler('await-session', { timeoutMs: 50 });
            await vi.advanceTimersByTimeAsync(60);
            await expect(pending).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
