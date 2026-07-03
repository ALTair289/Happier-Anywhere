import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeState = vi.hoisted(() => ({
    appState: 'active',
    platformOs: 'web',
    isTauriDesktop: false,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return runtimeState.platformOs;
            },
        },
        AppState: {
            get currentState() {
                return runtimeState.appState;
            },
        },
    });
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => runtimeState.isTauriDesktop,
}));

describe('isRuntimeActive', () => {
    const globalWithDocument = globalThis as unknown as {
        document?: { visibilityState?: string };
    };
    const originalDocument = globalWithDocument.document;

    beforeEach(() => {
        vi.resetModules();
        runtimeState.appState = 'active';
        runtimeState.platformOs = 'web';
        runtimeState.isTauriDesktop = false;
        globalWithDocument.document = { visibilityState: 'visible' };
    });

    afterEach(() => {
        vi.useRealTimers();
        globalWithDocument.document = originalDocument;
    });

    it('treats browser web as inactive when hidden', async () => {
        globalWithDocument.document = { visibilityState: 'hidden' };

        const { isRuntimeActive } = await import('./isRuntimeActive');

        expect(isRuntimeActive()).toBe(false);
    });

    it('treats Tauri desktop as active when the webview is hidden', async () => {
        runtimeState.isTauriDesktop = true;
        runtimeState.appState = 'background';
        globalWithDocument.document = { visibilityState: 'hidden' };

        const { isRuntimeActive } = await import('./isRuntimeActive');

        expect(isRuntimeActive()).toBe(true);
    });

    it('skips interval ticks while hidden and runs immediately when visible after overdue', async () => {
        vi.useFakeTimers();
        const visibilityListeners = new Set<() => void>();
        const documentStub = {
            visibilityState: 'hidden',
            addEventListener: vi.fn((event: string, listener: () => void) => {
                if (event === 'visibilitychange') visibilityListeners.add(listener);
            }),
            removeEventListener: vi.fn((event: string, listener: () => void) => {
                if (event === 'visibilitychange') visibilityListeners.delete(listener);
            }),
        };
        globalWithDocument.document = documentStub as unknown as Document;

        const { startRuntimeActiveGatedInterval } = await import('./isRuntimeActive') as {
            startRuntimeActiveGatedInterval: (tick: () => void, intervalMs: number) => () => void;
        };

        const tick = vi.fn();
        const stop = startRuntimeActiveGatedInterval(tick, 1_000);

        await vi.advanceTimersByTimeAsync(3_000);
        expect(tick).not.toHaveBeenCalled();

        documentStub.visibilityState = 'visible';
        for (const listener of visibilityListeners) listener();
        expect(tick).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(tick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(tick).toHaveBeenCalledTimes(2);

        stop();
        expect(documentStub.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(tick).toHaveBeenCalledTimes(2);
    });
});
