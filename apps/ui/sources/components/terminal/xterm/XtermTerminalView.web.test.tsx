/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fitSpy = vi.fn();
const focusSpy = vi.fn();
const loadAddonSpy = vi.fn();
const openSpy = vi.fn();
const attachCustomKeyEventHandlerSpy = vi.fn();
const onDataSpy = vi.fn();
const disposeSpy = vi.fn();
const viewportTimerObservedDisposedSpy = vi.fn();
const terminalConstructorOptions: Record<string, unknown>[] = [];

class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    disposed = false;

    constructor(options: Record<string, unknown> = {}) {
        this.options = options;
        terminalConstructorOptions.push(options);
        // xterm 5.5's Viewport constructor queues an untracked syncScrollArea
        // timer. Model that third-party lifecycle boundary here.
        setTimeout(() => viewportTimerObservedDisposedSpy(this.disposed), 0);
    }

    loadAddon = loadAddonSpy;
    open = openSpy;
    focus = focusSpy;
    clear = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    attachCustomKeyEventHandler = attachCustomKeyEventHandlerSpy;
    write = vi.fn((_data: string, callback?: () => void) => callback?.());
    dispose = () => {
        this.disposed = true;
        disposeSpy();
    };

    onData(callback: (data: string) => void) {
        onDataSpy.mockImplementation(callback);
        return { dispose: vi.fn() };
    }
}

vi.mock('@xterm/xterm', () => ({
    Terminal: MockTerminal,
}));

vi.mock('@xterm/addon-fit', () => ({
    FitAddon: class {
        fit = fitSpy;
    },
}));

vi.mock('@xterm/addon-web-links', () => ({
    WebLinksAddon: class {},
}));

vi.mock('@xterm/addon-webgl', () => ({
    WebglAddon: class {},
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#000000',
                surfaceSelected: '#333333',
                text: '#ffffff',
            },
        },
    });
});

describe('XtermTerminalView.web', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        fitSpy.mockReset();
        focusSpy.mockReset();
        loadAddonSpy.mockReset();
        openSpy.mockReset();
        attachCustomKeyEventHandlerSpy.mockReset();
        onDataSpy.mockReset();
        disposeSpy.mockReset();
        viewportTimerObservedDisposedSpy.mockReset();
        terminalConstructorOptions.length = 0;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        if (vi.isFakeTimers()) {
            await vi.runAllTimersAsync();
        } else {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        container.remove();
        vi.useRealTimers();
    });

    it('refocuses the terminal when the web container receives mouse down', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 40);
            });
        });

        const terminalContainer = container.querySelector('[data-testid="terminal"]');
        expect(terminalContainer).not.toBeNull();
        const initialFocusCalls = focusSpy.mock.calls.length;
        expect(initialFocusCalls).toBeGreaterThan(0);

        await act(async () => {
            terminalContainer!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        });

        expect(focusSpy.mock.calls.length).toBe(initialFocusCalls + 1);
    });

    it('opts out of xterm screen reader DOM mode in the web surface', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        expect(terminalConstructorOptions[0]).toEqual(
            expect.objectContaining({ screenReaderMode: false }),
        );
    });

    it('lets xterm viewport timers settle before disposing the terminal', async () => {
        vi.useFakeTimers();
        const { XtermTerminalView } = await import('./XtermTerminalView.web');

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        await act(async () => {
            root.render(<></>);
        });

        expect(disposeSpy).not.toHaveBeenCalled();

        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(viewportTimerObservedDisposedSpy).toHaveBeenCalledWith(false);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
});
