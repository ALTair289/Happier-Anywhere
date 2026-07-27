import { Redirect, Stack, router, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Keyboard, Platform, Pressable, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { isRunningOnMac } from '@/utils/platform/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { isPublicRouteForUnauthenticated } from '@/auth/routing/authRouting';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { getActiveServerUrl, getTabActiveServerId } from '@/sync/domains/server/serverProfiles';
import { isSameServerUrl, normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { bootstrapActiveServerFromWebLocation, readWebServerUrlOverrideFromLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { buildTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { useWebInitialRouteReconcile } from '@/hooks/ui/useWebInitialRouteReconcile';
import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import {
    createFriendsStackScreenOptions,
    createInboxStackScreenOptions,
} from '@/utils/navigation/createSocialStackScreenOptions';
import { ActivityBadgeRuntime } from '@/activity/badges/ActivityBadgeRuntime';
import { ActivityLocalNotificationRuntime } from '@/activity/notifications/runtime/ActivityLocalNotificationRuntime';
import { PushNotificationPermissionPrimingRuntime } from '@/activity/notifications/permission/PushNotificationPermissionPrimingRuntime';
import { DesktopTrayRuntime } from '@/desktop/tray/DesktopTrayRuntime';
import { ReleaseNotesAutoShowMount } from '@/changelog/releaseNotes';
import { useNotificationResponseRouting } from '@/activity/notifications/runtime/useNotificationResponseRouting';
import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { MobileBottomChromeHost } from '@/components/navigation/mobile/chrome/MobileBottomChromeHost';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { DesktopPetOverlayRuntimeMount } from '@/components/pets/runtime/DesktopPetOverlayRuntimeMount';
import { PetAppShellCompanionMount } from '@/components/pets/runtime/PetAppShellCompanionMount';
import { isDesktopPetOverlayWindowContext } from '@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext';
import { SessionCockpitChromeRegistryProvider } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

const bootstrappedWebServerOverride = bootstrapActiveServerFromWebLocation({ scope: 'device' });
const DESKTOP_PET_OVERLAY_SCREEN_OPTIONS = { headerShown: false } as const;
const MAIN_TAB_STACK_SCREEN_OPTIONS = { animation: 'none' } as const;
const SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS = {
    animation: 'none',
    headerShown: false,
} as const;
const UNAUTH_SHELL_STACK_SCREEN_OPTIONS = { headerShown: false } as const;
const NEW_SESSION_HEADER_TITLE_TYPOGRAPHY = Typography.header();

function NewSessionKeyboardDismissHeaderTitle(): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <Pressable
            accessibilityLabel={t('newSession.title')}
            accessibilityRole="button"
            onPress={Keyboard.dismiss}
            testID="new-session-header-keyboard-dismiss"
        >
            <Text
                style={[
                    NEW_SESSION_HEADER_TITLE_TYPOGRAPHY,
                    { color: theme.colors.chrome.header.foreground },
                ]}
            >
                {t('newSession.title')}
            </Text>
        </Pressable>
    );
}

const AuthenticatedAppShellRuntimes = React.memo(function AuthenticatedAppShellRuntimes(): React.ReactElement {
    return (
        <>
            <PushNotificationPermissionPrimingRuntime />
            <DesktopPetOverlayRuntimeMount />
            <PetAppShellCompanionMount />
            <ReleaseNotesAutoShowMount />
        </>
    );
});

function pickFirstRouteParamString(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return String(value[0] ?? '').trim();
    return String(value ?? '').trim();
}

function readLegacySessionIdFromWebLocation(): Readonly<{
    sessionId: string;
    serverId: string | null;
    messageId: string | null;
    jumpChildId: string | null;
    cleanedRelativeUrl: string;
}> | null {
    if (typeof window === 'undefined') return null;
    if (typeof window.location?.href !== 'string') return null;

    try {
        const current = new URL(window.location.href);
        // Legacy deep-link format: `/?id=<sessionId>` (no longer generated, but may be in old links or buggy flows).
        if (current.pathname !== '/') return null;

        const rawSessionId = (current.searchParams.get('id') ?? '').trim();
        if (!rawSessionId) return null;

        const rawServerId = (current.searchParams.get('serverId') ?? '').trim();
        const rawMessageId = (current.searchParams.get('messageId') ?? '').trim();
        const rawJumpChildId = (current.searchParams.get('jumpChildId') ?? '').trim();

        current.searchParams.delete('id');
        const search = current.searchParams.toString();
        const cleanedRelativeUrl = `${current.pathname}${search ? `?${search}` : ''}${current.hash ?? ''}`;
        return {
            sessionId: rawSessionId,
            serverId: rawServerId || null,
            messageId: rawMessageId || null,
            jumpChildId: rawJumpChildId || null,
            cleanedRelativeUrl,
        };
    } catch {
        return null;
    }
}

export default function RootLayout() {
    const auth = useAuth();
    const segments = useSegments();
    const pathname = usePathname();
    const globalSearchParams = useGlobalSearchParams<{
        server?: string | string[];
        serverId?: string | string[];
        url?: string | string[];
        auto?: string | string[];
    }>();
    const { theme } = useUnistyles();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const happierVoiceSupported = useHappierVoiceSupport();

    useWebInitialRouteReconcile({ routerPathname: pathname });

    const bootstrappedWebServerOverrideHandledRef = React.useRef(false);
    const serverOverrideParamSignal = React.useMemo(() => [
        pickFirstRouteParamString(globalSearchParams.server),
        pickFirstRouteParamString(globalSearchParams.serverId),
        pickFirstRouteParamString(globalSearchParams.url),
        pickFirstRouteParamString(globalSearchParams.auto),
    ].join('\u0000'), [
        globalSearchParams.auto,
        globalSearchParams.server,
        globalSearchParams.serverId,
        globalSearchParams.url,
    ]);
    React.useEffect(() => {
        const liveOverride = readWebServerUrlOverrideFromLocation();
        const shouldUseBootstrappedOverride =
            !liveOverride
            && !bootstrappedWebServerOverrideHandledRef.current
            && bootstrappedWebServerOverride;
        const override = liveOverride ?? (shouldUseBootstrappedOverride ? bootstrappedWebServerOverride : null);
        if (!override) return;
        if (shouldUseBootstrappedOverride) {
            bootstrappedWebServerOverrideHandledRef.current = true;
        }

        const desired = normalizeServerUrl(override.serverUrl);
        if (!desired) return;

        const current = normalizeServerUrl(getActiveServerUrl());
        if (isSameServerUrl(desired, current)) {
            if (bootstrappedWebServerOverride && isSameServerUrl(bootstrappedWebServerOverride.serverUrl, desired)) {
                fireAndForget(auth.refreshFromActiveServer(), { tag: 'RootLayout.webServerOverrideBootstrapped.refreshAuth' });
            }
            try {
                window.history.replaceState(null, '', override.cleanedRelativeUrl);
            } catch {
                // ignore
            }
            return;
        }

        fireAndForget((async () => {
            try {
                await upsertActivateAndSwitchServer({
                    serverUrl: desired,
                    source: 'url',
                    scope: 'device',
                    refreshAuth: auth.refreshFromActiveServer,
                });
            } catch {
                // keep URL normalization best-effort; server switch can still be repaired elsewhere
            }
        })(), { tag: 'RootLayout.webServerOverride' });

        try {
            window.history.replaceState(null, '', override.cleanedRelativeUrl);
        } catch {
            // ignore
        }
    }, [auth, pathname, serverOverrideParamSignal]);

    const legacySessionDeepLinkHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (legacySessionDeepLinkHandledRef.current) return;
        if (!auth.isAuthenticated) return;

        const legacy = readLegacySessionIdFromWebLocation();
        if (!legacy) return;
        legacySessionDeepLinkHandledRef.current = true;

        try {
            window.history.replaceState(null, '', legacy.cleanedRelativeUrl);
        } catch {
            // ignore
        }

        const suffix = legacy.messageId ? `/message/${encodeURIComponent(legacy.messageId)}` : '';
        router.replace(buildScopedSessionRouteHref({
            sessionId: legacy.sessionId,
            serverId: legacy.serverId,
            suffix,
            query: {
                jumpChildId: legacy.jumpChildId,
            },
        }));
    }, [auth.isAuthenticated]);

    const shouldRedirect = !auth.isAuthenticated && !isPublicRouteForUnauthenticated(segments);
    const pendingTerminalHandledRef = React.useRef(false);
    useNotificationResponseRouting({
        enabled: auth.isAuthenticated,
        refreshAuth: auth.refreshFromActiveServer,
    });

    React.useEffect(() => {
        if (!auth.isAuthenticated) {
            pendingTerminalHandledRef.current = false;
            return;
        }

        const pendingTerminalConnect = getPendingTerminalConnect();
        if (pendingTerminalConnect) {
            if (pendingTerminalHandledRef.current) return;
            // Avoid leaking the terminal connect key via query params; use hash params on the dedicated
            // `/terminal/connect` route instead.
            const route = buildTerminalConnectWebHref({
                publicKeyB64Url: pendingTerminalConnect.publicKeyB64Url,
                serverUrl: pendingTerminalConnect.serverUrl,
            });

            // If we are already on the terminal-connect page (which persists a pending connect while
            // clearing the URL hash for safety), do not navigate away.
            if (segments.includes('terminal') && segments.includes('connect')) return;

            const target = normalizeServerUrl(pendingTerminalConnect.serverUrl);
            const active = normalizeServerUrl(getActiveServerUrl());
            if (target && (target !== active || getTabActiveServerId())) {
                pendingTerminalHandledRef.current = true;
                fireAndForget((async () => {
                    try {
                        await upsertActivateAndSwitchServer({
                            serverUrl: pendingTerminalConnect.serverUrl,
                            source: 'url',
                            scope: 'device',
                            refreshAuth: auth.refreshFromActiveServer,
                        });
                    } catch {
                        // keep navigation best-effort; terminal flow can still recover with explicit server param
                    }
                    router.push(route);
                })(), { tag: 'RootLayout.pendingTerminalConnect' });
                return;
            }

            pendingTerminalHandledRef.current = true;
            router.push(route);
            return;
        }

        pendingTerminalHandledRef.current = false;
    }, [auth.isAuthenticated]);

    // Server capability gating: if the server doesn't support Happier Voice (misconfigured/disabled),
    // default the user's voice mode to off (they can still choose BYO ElevenLabs in settings).
    React.useEffect(() => {
        if (!auth.isAuthenticated) return;
        if (happierVoiceSupported !== false) return;
        let cancelled = false;
        fireAndForget((async () => {
            try {
                // Defer loading sync/storage modules until needed to keep module evaluation light.
                const [{ storage }, { sync }] = await Promise.all([
                    import('@/sync/domains/state/storage'),
                    import('@/sync/sync'),
                ]);

                if (cancelled) return;
                const voice = (storage.getState().settings as any)?.voice ?? null;
                const providerId = voice?.providerId ?? 'off';
                const billingMode = voice?.adapters?.realtime_elevenlabs?.billingMode ?? 'happier';
                if (providerId !== 'realtime_elevenlabs') return;
                if (billingMode !== 'happier') return;
                sync.applySettings({ voice: { ...voice, providerId: 'off' } }, { source: 'system' });
            } catch {
                // Non-fatal: feature gating should never crash the root layout.
            }
        })(), { tag: 'RootLayout.happierVoiceGate' });
        return () => {
            cancelled = true;
        };
    }, [auth.isAuthenticated, happierVoiceSupported]);

    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const isDesktopPetOverlayWindow = isDesktopPetOverlayWindowContext();
    const baseStackScreenOptions = React.useMemo(() => createAppStackScreenOptions({
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [shouldUseCustomHeader, theme]);
    const mixedUseRouteScreenOptions = React.useMemo(() => {
        if (!auth.isAuthenticated) {
            return {
                terminal: UNAUTH_SHELL_STACK_SCREEN_OPTIONS,
                restore: UNAUTH_SHELL_STACK_SCREEN_OPTIONS,
                restoreManual: UNAUTH_SHELL_STACK_SCREEN_OPTIONS,
                restoreLostAccess: UNAUTH_SHELL_STACK_SCREEN_OPTIONS,
            };
        }

        return {
            terminal: {
                headerShown: true,
                headerTitle: t('terminal.connectTerminal'),
                headerBackTitle: t('common.back'),
            },
            restore: {
                headerShown: true,
                headerTitle: t('connect.restoreAccount'),
                headerBackTitle: t('common.back'),
            },
            restoreManual: {
                headerShown: true,
                headerTitle: t('navigation.restoreWithSecretKey'),
                headerBackTitle: t('common.back'),
            },
            restoreLostAccess: {
                headerShown: true,
                headerTitle: t('connect.lostAccessTitle'),
                headerBackTitle: t('common.back'),
            },
        };
    }, [auth.isAuthenticated]);
    // Avoid rendering protected screens for a frame during redirect.
    if (shouldRedirect) {
        return <Redirect href="/" />;
    }

    if (isDesktopPetOverlayWindow) {
        return (
            <Stack screenOptions={DESKTOP_PET_OVERLAY_SCREEN_OPTIONS}>
                <Stack.Screen
                    name="desktop/pet-overlay"
                    options={DESKTOP_PET_OVERLAY_SCREEN_OPTIONS}
                />
            </Stack>
        );
    }

    return (
        <SessionCockpitChromeRegistryProvider>
            <ActivityBadgeRuntime />
            <ActivityLocalNotificationRuntime />
            <DesktopTrayRuntime />
            {auth.isAuthenticated ? <AuthenticatedAppShellRuntimes /> : null}
            {debugRouterEnabled && Platform.OS === 'web' ? (
                <View
                    testID="debug-router-pathname"
                    style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
                >
                    <Text>{pathname}</Text>
                </View>
            ) : null}
            <Stack screenOptions={baseStackScreenOptions}>
            <Stack.Screen
                name="desktop/pet-overlay"
                options={DESKTOP_PET_OVERLAY_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="index"
                options={{
                    ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                    headerShown: false,
                    headerTitle: '',
                }}
            />
            <Stack.Screen
                name="inbox/index"
                options={{
                    ...createInboxStackScreenOptions(t),
                    ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                }}
            />
            <Stack.Screen
                name="friends/index"
                options={{
                    ...createFriendsStackScreenOptions(t),
                    ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                }}
            />
            <Stack.Screen
                name="oauth/[provider]"
                options={UNAUTH_SHELL_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="mtls"
                options={UNAUTH_SHELL_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="setup"
                options={UNAUTH_SHELL_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="settings"
                options={{
                    ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="automations/index"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.automations'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="automations/[id]"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.automation'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="automations/new"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.newAutomation'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/info"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs"
                options={{
                    headerShown: true,
                    headerTitle: t('runs.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs/new"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs/[runId]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/files"
                // The Files/SCM mobile route renders the exact same surface as the desktop right panel,
                // including its own header (tabs + close button). Avoid double headers.
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/git"
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/details"
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/terminal"
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/index"
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/recent"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/archived"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="terminal/connect"
                options={mixedUseRouteScreenOptions.terminal}
            />
            <Stack.Screen
                name="terminal/index"
                options={mixedUseRouteScreenOptions.terminal}
            />
            <Stack.Screen
                name="scan/terminal"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="scan/account"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="restore/index"
                options={mixedUseRouteScreenOptions.restore}
            />
            <Stack.Screen
                name="restore/show-qr"
                options={UNAUTH_SHELL_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="restore/manual"
                options={mixedUseRouteScreenOptions.restoreManual}
            />
            <Stack.Screen
                name="restore/lost-access"
                options={mixedUseRouteScreenOptions.restoreLostAccess}
            />
            <Stack.Screen
                name="changelog"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.whatsNew'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/index"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/[id]"
                options={{
                    headerShown: false, // We'll set header dynamically
                }}
            />
            <Stack.Screen
                name="artifacts/new"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.new'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="artifacts/edit/[id]"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.edit'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="friends/manage"
                options={({ navigation }) => ({
                    headerShown: true,
                    headerTitle: t('navigation.friends'),
                    headerBackTitle: t('common.back'),
                    headerRight: () =>
                        (
                            <TouchableOpacity
                                onPress={() => navigation.navigate('friends/search' as never)}
                                style={{ paddingHorizontal: 16, opacity: friendsIdentityReady ? 1 : 0.5 }}
                                disabled={!friendsIdentityReady}
                                accessibilityState={{ disabled: !friendsIdentityReady }}
                            >
                                <Text style={{ color: theme.colors.button.primary.tint, fontSize: 16 }}>
                                    {t('friends.addFriend')}
                                </Text>
                            </TouchableOpacity>
                        ),
                })}
            />
            <Stack.Screen
                name="friends/search"
                options={{
                    headerShown: true,
                    headerTitle: t('friends.addFriend'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="user/[id]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="dev/index"
                options={{
                    headerTitle: t('navigation.developerTools'),
                }}
            />

            <Stack.Screen
                name="dev/list-demo"
                options={{
                    headerTitle: t('navigation.listComponentsDemo'),
                }}
            />
            <Stack.Screen
                name="dev/typography"
                options={{
                    headerTitle: t('navigation.typography'),
                }}
            />
            <Stack.Screen
                name="dev/colors"
                options={{
                    headerTitle: t('navigation.colors'),
                }}
            />
            <Stack.Screen
                name="dev/tools2"
                options={{
                    headerTitle: t('navigation.toolViewsDemo'),
                }}
            />
            <Stack.Screen
                name="dev/shimmer-demo"
                options={{
                    headerTitle: t('navigation.shimmerViewDemo'),
                }}
            />
            <Stack.Screen
                name="dev/multi-text-input"
                options={{
                    headerTitle: t('navigation.multiTextInput'),
                }}
            />
            <Stack.Screen
                name="new/pick/machine"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/path"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/profile"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/server"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/profile-edit"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/secret-requirement"
                options={{
                    headerShown: false,
                    // /new is presented modally on iOS. Ensure this overlay screen is too,
                    // otherwise it can end up pushed "behind" the modal (invisible but on the back stack).
                    presentation: Platform.OS === 'ios' ? 'containedModal' : 'modal',
                }}
            />
            <Stack.Screen
                name="new/index"
                options={({ navigation }) => ({
                    headerShown: true,
                    headerBackTitle: t('common.cancel'),
                    presentation: Platform.OS === 'ios' ? 'pageSheet' : 'modal',
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                    // Swipe-to-dismiss is not consistently available across platforms; always provide a close button.
                    headerBackVisible: false,
                    headerTitle: Platform.OS === 'web'
                        ? t('newSession.title')
                        : NewSessionKeyboardDismissHeaderTitle,
                    headerLeft: () => null,
                    headerRight: Platform.OS === 'web'
                        ? undefined
                        : () => <AppHeaderCloseButton testID="new-session-cancel" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />,
                })}
            />
            <Stack.Screen
                name="direct/browse"
                options={({ navigation }) => ({
                    headerTitle: t('directSessions.browseTitle'),
                    headerShown: true,
                    headerBackTitle: t('common.cancel'),
                    presentation: 'modal',
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                    headerBackVisible: false,
                    headerLeft: () => null,
                    headerRight: () => <AppHeaderCloseButton testID="direct-session-browse-cancel" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />,
                })}
            />
            <Stack.Screen
                name="zen/index"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="zen/new"
                options={{
                    presentation: 'modal',
                    headerTitle: t('navigation.zenNewTask'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="zen/view"
                options={{
                    presentation: 'modal',
                    headerTitle: t('navigation.zenTaskDetails'),
                    headerBackTitle: t('common.back'),
                }}
            />
            </Stack>
            <MobileBottomChromeHost />
        </SessionCockpitChromeRegistryProvider>
    );
}
