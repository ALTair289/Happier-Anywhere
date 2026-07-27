import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const navigatorState = vi.hoisted(() => ({
    screenOptions: null as null | Record<string, unknown>,
    navigationContainerLinking: null as null | Record<string, unknown>,
    registeredChrome: null as null | {
        switchSurface: (surface: 'chat' | 'browse' | 'git' | 'navigation' | 'tabs' | 'terminal') => void;
    },
    localSettingReads: [] as string[],
    persistedSurfaces: [] as Array<Readonly<{ sessionId: string; surface: string }>>,
    screenOptionsByName: {} as Record<string, Record<string, unknown> | null>,
    surfaceSwitchers: [] as Array<(surface: 'chat' | 'browse' | 'git' | 'navigation' | 'tabs' | 'terminal') => void>,
}));

const navigationFocusState = vi.hoisted(() => {
    let focused = true;
    const listeners = new Set<() => void>();

    return {
        getSnapshot: () => focused,
        setFocused: (nextFocused: boolean) => {
            focused = nextFocused;
            for (const listener of listeners) {
                listener();
            }
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
});

vi.mock('@react-navigation/native', () => ({
    NavigationContainer: ({ children, linking }: { children?: React.ReactNode; linking?: Record<string, unknown> }) => {
        navigatorState.navigationContainerLinking = linking ?? null;
        return React.createElement('NavigationContainer', { linking }, children);
    },
    NavigationIndependentTree: ({ children }: { children?: React.ReactNode }) =>
        React.createElement('NavigationIndependentTree', null, children),
    useIsFocused: () => React.useSyncExternalStore(
        navigationFocusState.subscribe,
        navigationFocusState.getSnapshot,
        navigationFocusState.getSnapshot,
    ),
}));

vi.mock('@react-navigation/bottom-tabs', () => ({
    createBottomTabNavigator: () => ({
        Navigator: ({ children, screenOptions, tabBar }: {
            children?: React.ReactNode;
            screenOptions?: Record<string, unknown>;
            tabBar?: (props: {
                state: { index: number; routes: Array<{ key: string; name: string }> };
                navigation: {
                    emit: () => { defaultPrevented: boolean };
                    navigate: (name: string) => void;
                };
            }) => React.ReactNode;
        }) => {
            navigatorState.screenOptions = screenOptions ?? null;
            const routes = ['chat', 'browse', 'git', 'navigation', 'tabs', 'terminal'].map((name) => ({ key: name, name }));
            return React.createElement('BottomTabNavigator', { screenOptions }, [
                React.createElement(React.Fragment, { key: 'screens' }, children),
                React.createElement(React.Fragment, { key: 'tab-bar' }, tabBar?.({
                    state: { index: 0, routes },
                    navigation: {
                        emit: () => ({ defaultPrevented: false }),
                        navigate: () => {},
                    },
                })),
            ]);
        },
        Screen: ({ children, name, options }: {
            children?: (props: { navigation: { navigate: () => void } }) => React.ReactNode;
            name: string;
            options?: Record<string, unknown>;
        }) => {
            navigatorState.screenOptionsByName[name] = options ?? null;
            return React.createElement('BottomTabScreen', { name, options }, typeof children === 'function'
                ? children({ navigation: { navigate: () => {} } })
                : children);
        },
    }),
}));

vi.mock('./SessionCockpitSurfaceScreen', () => ({
    SessionCockpitSurfaceScreen: (props: Record<string, unknown>) =>
        React.createElement('SessionCockpitSurfaceScreen', props),
}));

vi.mock('./SessionCockpitSurfaceNavigation', () => ({
    SessionCockpitSurfaceNavigationProvider: ({
        children,
        value,
    }: {
        children?: React.ReactNode;
        value: { switchSurface: (surface: 'chat' | 'browse' | 'git' | 'navigation' | 'tabs' | 'terminal') => void };
    }) => {
        navigatorState.surfaceSwitchers.push(value.switchSurface);
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('./SessionCockpitChromeRegistry', () => ({
    useSessionCockpitChromeRegister: () => (model: {
        switchSurface: (surface: 'chat' | 'browse' | 'git' | 'navigation' | 'tabs' | 'terminal') => void;
    }) => {
        navigatorState.registeredChrome = model;
        return () => {};
    },
}));

vi.mock('@/components/appShell/panes/hooks/useDetailsTabCount', () => ({
    useDetailsTabCount: () => 0,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        navigatorState.localSettingReads.push(key);
        return null;
    },
    useLocalSettingMutable: () => [null, () => {}],
    usePersistSessionLastMobileSurface: () => (sessionId: string, surface: string) => {
        navigatorState.persistedSurfaces.push({ sessionId, surface });
    },
}));

describe('SessionCockpitTabNavigator keyboard behavior', () => {
    beforeEach(() => {
        navigatorState.registeredChrome = null;
        navigatorState.localSettingReads = [];
        navigatorState.persistedSurfaces = [];
        navigatorState.screenOptionsByName = {};
        navigatorState.surfaceSwitchers = [];
        navigationFocusState.setFocused(true);
    });

    it('does not ask the native tab navigator to hide tab chrome during keyboard transitions', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        expect(navigatorState.screenOptions?.tabBarHideOnKeyboard).toBe(false);
        expect(navigatorState.navigationContainerLinking).toEqual({ enabled: false, prefixes: [] });
    });

    it('keeps nested navigation container and navigator options stable across rerenders', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = (terminalTabAvailable: boolean) => (
            <SessionCockpitTabNavigator
                initialSurface="chat"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={terminalTabAvailable}
            />
        );

        const screen = await renderScreen(renderNavigator(true));
        const firstLinking = navigatorState.navigationContainerLinking;
        const firstScreenOptions = navigatorState.screenOptions;

        await screen.update(renderNavigator(false));

        expect(navigatorState.navigationContainerLinking).toBe(firstLinking);
        expect(navigatorState.screenOptions).toBe(firstScreenOptions);
    });

    it('persists tab switches without subscribing the navigator to the whole persisted surface map', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        navigatorState.surfaceSwitchers[0]?.('navigation');

        expect(navigatorState.localSettingReads).not.toContain('sessionLastMobileSurfaceBySessionId');
        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: 'navigation' }]);
    });

    it('eagerly mounts the chat host when transcript navigation is the initial cockpit surface', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="navigation"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        expect(navigatorState.screenOptionsByName.chat).toEqual(expect.objectContaining({
            lazy: false,
        }));
    });

    it('keeps an inactive eager chat scene mounted while excluding its descendants, then restores activity on focus', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        navigationFocusState.setFocused(false);

        try {
            const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
            const screen = await renderScreen(
                <SessionCockpitTabNavigator
                    initialSurface="navigation"
                    scopeId="session:s1"
                    sessionId="s1"
                    terminalTabAvailable
                />,
            );

            const inactiveChatScene = screen.findByTestId('session-cockpit-scene:chat');
            expect(inactiveChatScene).not.toBeNull();
            expect(screen.findAllByType('SessionCockpitSurfaceScreen').filter((node) => node.props.surface === 'chat')).toHaveLength(1);
            expect(inactiveChatScene?.props).toEqual(expect.objectContaining({
                inert: true,
                'aria-hidden': true,
                pointerEvents: 'none',
            }));

            await act(async () => {
                navigationFocusState.setFocused(true);
            });
            expect(screen.findByTestId('session-cockpit-scene:chat')?.props).toEqual(expect.objectContaining({
                inert: undefined,
                'aria-hidden': undefined,
                pointerEvents: 'auto',
            }));
            expect(screen.findAllByType('SessionCockpitSurfaceScreen').filter((node) => node.props.surface === 'chat')).toHaveLength(1);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('hides inactive native scene descendants from accessibility and pointer interaction', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        navigationFocusState.setFocused(false);

        try {
            const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
            const screen = await renderScreen(
                <SessionCockpitTabNavigator
                    initialSurface="navigation"
                    scopeId="session:s1"
                    sessionId="s1"
                    terminalTabAvailable
                />,
            );

            expect(screen.findByTestId('session-cockpit-scene:chat')?.props).toEqual(expect.objectContaining({
                inert: undefined,
                'aria-hidden': undefined,
                accessibilityElementsHidden: true,
                importantForAccessibility: 'no-hide-descendants',
                pointerEvents: 'none',
            }));

            await act(async () => {
                navigationFocusState.setFocused(true);
            });
            expect(screen.findByTestId('session-cockpit-scene:chat')?.props).toEqual(expect.objectContaining({
                accessibilityElementsHidden: false,
                importantForAccessibility: 'auto',
                pointerEvents: 'auto',
            }));
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});
