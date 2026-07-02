import * as React from 'react';
import {
    createBottomTabNavigator,
    type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import { NavigationContainer, NavigationIndependentTree } from '@react-navigation/native';

import { usePersistSessionLastMobileSurface } from '@/sync/domains/state/storage';
import { useDetailsTabCount } from '@/components/appShell/panes/hooks/useDetailsTabCount';

import {
    type SessionMobileSurface,
} from './sessionCockpitState';
import { useSessionCockpitChromeRegister } from './SessionCockpitChromeRegistry';
import { SessionCockpitSurfaceNavigationProvider } from './SessionCockpitSurfaceNavigation';
import {
    SessionCockpitSurfaceScreen,
    type SessionCockpitSurfaceScreenProps,
} from './SessionCockpitSurfaceScreen';

type SessionCockpitTabParamList = {
    chat: undefined;
    browse: undefined;
    git: undefined;
    navigation: undefined;
    tabs: undefined;
    terminal: undefined;
};

const Tab = createBottomTabNavigator<SessionCockpitTabParamList>();

const SESSION_COCKPIT_SURFACES_WITH_TERMINAL: readonly SessionMobileSurface[] = ['chat', 'browse', 'git', 'navigation', 'tabs', 'terminal'];
const SESSION_COCKPIT_SURFACES_WITHOUT_TERMINAL: readonly SessionMobileSurface[] = ['chat', 'browse', 'git', 'navigation', 'tabs'];
const DISABLED_NAVIGATION_LINKING = { enabled: false, prefixes: [] };
const SESSION_COCKPIT_CHAT_PRELOAD_SCREEN_OPTIONS = {
    lazy: false,
} as const;
const SESSION_COCKPIT_TAB_SCREEN_OPTIONS = {
    headerShown: false,
    animation: 'none',
    lazy: true,
    freezeOnBlur: true,
    tabBarHideOnKeyboard: false,
} as const;

type SessionCockpitTabNavigatorProps = Omit<SessionCockpitSurfaceScreenProps, 'surface'> & Readonly<{
    initialSurface: SessionMobileSurface;
}>;

function resolveAvailableSurfaces(terminalTabAvailable: boolean): readonly SessionMobileSurface[] {
    return terminalTabAvailable
        ? SESSION_COCKPIT_SURFACES_WITH_TERMINAL
        : SESSION_COCKPIT_SURFACES_WITHOUT_TERMINAL;
}

function resolveInitialSurface(
    initialSurface: SessionMobileSurface,
    terminalTabAvailable: boolean,
): SessionMobileSurface {
    if (initialSurface === 'terminal' && !terminalTabAvailable) {
        return 'chat';
    }
    return initialSurface;
}

export const SessionCockpitTabNavigator = React.memo((props: SessionCockpitTabNavigatorProps) => {
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const initialSurface = resolveInitialSurface(props.initialSurface, terminalTabAvailable);
    const surfaces = resolveAvailableSurfaces(terminalTabAvailable);
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const persistSessionSurface = React.useCallback((surface: SessionMobileSurface) => {
        persistSessionLastMobileSurface(props.sessionId, surface);
    }, [persistSessionLastMobileSurface, props.sessionId]);

    return (
        <NavigationIndependentTree>
            <NavigationContainer linking={DISABLED_NAVIGATION_LINKING}>
                <Tab.Navigator
                    backBehavior="history"
                    initialRouteName={initialSurface}
                    screenOptions={SESSION_COCKPIT_TAB_SCREEN_OPTIONS}
                    tabBar={(tabBarProps) => (
                        <SessionCockpitNavigatorChromeBridge
                            {...tabBarProps}
                            sessionId={props.sessionId}
                            terminalTabAvailable={terminalTabAvailable}
                        />
                    )}
                >
                    {surfaces.map((surface) => (
                        <Tab.Screen
                            key={surface}
                            name={surface}
                            options={surface === 'chat' && initialSurface === 'navigation'
                                ? SESSION_COCKPIT_CHAT_PRELOAD_SCREEN_OPTIONS
                                : undefined}
                        >
                            {({ navigation }) => (
                                <SessionCockpitSurfaceNavigationProvider
                                    value={{
                                        switchSurface: (targetSurface) => {
                                            navigation.navigate(targetSurface);
                                            persistSessionSurface(targetSurface);
                                        },
                                    }}
                                >
                                    <SessionCockpitSurfaceScreen {...props} surface={surface} />
                                </SessionCockpitSurfaceNavigationProvider>
                            )}
                        </Tab.Screen>
                    ))}
                </Tab.Navigator>
            </NavigationContainer>
        </NavigationIndependentTree>
    );
});

function normalizeSurface(value: unknown): SessionMobileSurface | null {
    if (value === 'chat' || value === 'browse' || value === 'git' || value === 'navigation' || value === 'tabs' || value === 'terminal') {
        return value;
    }
    return null;
}

const SessionCockpitNavigatorChromeBridge = React.memo((props: BottomTabBarProps & Readonly<{
    sessionId: string;
    terminalTabAvailable: boolean;
}>) => {
    const register = useSessionCockpitChromeRegister();
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const openDetailsTabCount = useDetailsTabCount(`session:${props.sessionId}`);
    const activeSurface = normalizeSurface(props.state.routes[props.state.index]?.name) ?? 'chat';

    const persistSessionSurface = React.useCallback((surface: SessionMobileSurface) => {
        persistSessionLastMobileSurface(props.sessionId, surface);
    }, [persistSessionLastMobileSurface, props.sessionId]);

    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        const route = props.state.routes.find((candidate) => candidate.name === surface);
        if (!route) return;

        const event = props.navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
        });
        if (event.defaultPrevented) return;

        if (activeSurface !== surface) {
            props.navigation.navigate(route.name);
        }
        persistSessionSurface(surface);
    }, [activeSurface, persistSessionSurface, props.navigation, props.state.routes]);

    React.useEffect(() => register({
        sessionId: props.sessionId,
        activeSurface,
        terminalTabAvailable: props.terminalTabAvailable,
        openDetailsTabCount,
        switchSurface,
    }), [
        activeSurface,
        openDetailsTabCount,
        props.sessionId,
        props.terminalTabAvailable,
        register,
        switchSurface,
    ]);

    return null;
});
