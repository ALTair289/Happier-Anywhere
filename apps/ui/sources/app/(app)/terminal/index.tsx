import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { TerminalConnectRouteShell } from '@/components/terminal/connect/TerminalConnectRouteShell';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { getServerUrl } from '@/sync/domains/server/serverConfig';
import { clearPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import {
    buildTerminalConnectDeepLink,
    type ParsedTerminalConnectUrl,
} from '@/utils/path/terminalConnectUrl';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { Icon } from '@/components/ui/icons/Icon';

export default function TerminalScreen() {
    const router = useRouter();
    const searchParams = useLocalSearchParams();
    const { theme } = useUnistyles();
    const auth = useAuth();
    const authRedirectTriggeredRef = React.useRef(false);
    const navigateBackOrToHome = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);
    const openRelayCustomFlow = React.useCallback(() => {
        router.push('/setup?openCustom=1');
    }, [router]);
    const renderInShell = React.useCallback(
        (children: React.ReactNode) => (
            <TerminalConnectRouteShell
                enabled={!auth.isAuthenticated}
                stepId="terminal"
                testID="unauth-shell-route-terminal"
                contentTestID="terminal-route-content"
                onBack={navigateBackOrToHome}
                onOpenRelayCustomFlow={openRelayCustomFlow}
            >
                {children}
            </TerminalConnectRouteShell>
        ),
        [navigateBackOrToHome, openRelayCustomFlow],
    );

    // const [urlProcessed, setUrlProcessed] = useState(false);
    const publicKey = React.useMemo(() => {
        const keyParam = searchParams.key;
        if (typeof keyParam === 'string' && keyParam.trim()) return keyParam.trim();
        if (Array.isArray(keyParam) && keyParam[0]?.trim()) return keyParam[0].trim();

        // Legacy deep-link format: happier://terminal?<publicKeyB64Url>
        const knownParams = new Set(['key', 'server', 'pairingSecret', 'createdAt', 'expiresAt']);
        const unknownKeys = Object.keys(searchParams).filter((k) => !knownParams.has(k));
        if (unknownKeys.length !== 1) return null;
        const legacyKey = unknownKeys[0]?.trim();
        return legacyKey ?? null;
    }, [searchParams]);

    const serverUrl = React.useMemo(() => {
        const v = searchParams.server;
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (Array.isArray(v) && v[0]?.trim()) return v[0].trim();
        return null;
    }, [searchParams]);
    const pairing = React.useMemo<ParsedTerminalConnectUrl['pairing']>(() => {
        const readOne = (value: string | string[] | undefined): string =>
            typeof value === 'string' ? value.trim() : Array.isArray(value) ? String(value[0] ?? '').trim() : '';
        const secretB64Url = readOne(searchParams.pairingSecret);
        const createdAtMs = Number(readOne(searchParams.createdAt));
        const expiresAtMs = Number(readOne(searchParams.expiresAt));
        if (
            !secretB64Url
            || !Number.isSafeInteger(createdAtMs)
            || !Number.isSafeInteger(expiresAtMs)
            || createdAtMs < 0
            || expiresAtMs <= createdAtMs
        ) {
            return undefined;
        }
        return { secretB64Url, createdAtMs, expiresAtMs };
    }, [searchParams.createdAt, searchParams.expiresAt, searchParams.pairingSecret]);
    const { processAuthUrl, isLoading } = useConnectTerminal({
        onSuccess: () => {
            navigateBackOrToHome();
        },
        allowLoopbackServerOverride: true,
    });

    React.useEffect(() => {
        if (auth.isAuthenticated) return;
        if (!publicKey) return;
        if (authRedirectTriggeredRef.current) return;

        authRedirectTriggeredRef.current = true;
        const currentServerUrl = canonicalizeServerUrl(getServerUrl());
        const effectiveTarget = resolveEffectiveServerUrlOverride({
            requestedServerUrl: serverUrl,
            activeServerUrl: currentServerUrl,
            allowLoopbackSwitch: true,
        });
        setPendingTerminalConnect({
            publicKeyB64Url: publicKey,
            serverUrl: effectiveTarget || currentServerUrl || getServerUrl(),
            ...(pairing ? { pairing } : {}),
        });
        router.replace('/');
    }, [auth.isAuthenticated, pairing, publicKey, router, serverUrl]);

    const handleConnect = async () => {
        if (publicKey) {
            const authUrl = buildTerminalConnectDeepLink({
                publicKeyB64Url: publicKey,
                serverUrl,
                pairing,
            });
            await processAuthUrl(authUrl);
        }
    };

    const handleReject = () => {
        clearPendingTerminalConnect();
        navigateBackOrToHome();
    };

    if (!auth.isAuthenticated && publicKey) {
        return renderInShell(
            <ItemList>
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: theme.colors.text.secondary,
                            textAlign: 'center',
                            lineHeight: 20
                        }}>
                            {t('modals.pleaseSignInFirst')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>,
        );
    }

    // Show error if no key found
    if (!publicKey) {
        return renderInShell(
            <ItemList>
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Icon
                            name="warning"
                            size={48}
                            color={theme.colors.state.danger.foreground}
                            style={{ marginBottom: 16 }}
                        />
                        <Text style={{
                            ...Typography.default('semiBold'),
                            fontSize: 16,
                            color: theme.colors.state.danger.foreground,
                            textAlign: 'center',
                            marginBottom: 8
                        }}>
                            {t('terminal.invalidConnectionLink')}
                        </Text>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: theme.colors.text.secondary,
                            textAlign: 'center',
                            lineHeight: 20
                        }}>
                            {t('terminal.invalidConnectionLinkDescription')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>,
        );
    }

    // Show confirmation screen for valid connection
    return renderInShell(
        <ItemList>
            {/* Connection Request Header */}
            <ItemGroup>
                <View style={{
                    alignItems: 'center',
                    paddingVertical: 24,
                    paddingHorizontal: 16
                }}>
                    <Icon
                        name="terminal"
                        size={48}
                        color={theme.colors.radio.active}
                        style={{ marginBottom: 16 }}
                    />
                    <Text style={{
                        ...Typography.default('semiBold'),
                        fontSize: 20,
                        textAlign: 'center',
                        marginBottom: 12,
                        color: theme.colors.text.primary
                    }}>
                        {t('terminal.connectTerminal')}
                    </Text>
                    <Text style={{
                        ...Typography.default(),
                        fontSize: 14,
                        color: theme.colors.text.secondary,
                        textAlign: 'center',
                        lineHeight: 20
                    }}>
                        {t('terminal.terminalRequestDescription')}
                    </Text>
                </View>
            </ItemGroup>

            {/* Connection Details */}
            <ItemGroup title={t('terminal.connectionDetails')}>
                <Item
                    title={t('terminal.publicKey')}
                    detail={`${publicKey.substring(0, 12)}...`}
                    icon={<Icon name="key" size={29} color={theme.colors.radio.active} />}
                    showChevron={false}
                />
                <Item
                    title={t('terminal.encryption')}
                    detail={t('terminal.endToEndEncrypted')}
                    icon={<Icon name="lock" size={29} color={theme.colors.state.success.foreground} />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Action Buttons */}
            <ItemGroup>
                <View style={{
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    gap: 12
                }}>
                    <RoundButton
                        testID="terminal-connect-approve"
                        title={isLoading ? t('terminal.connecting') : t('terminal.acceptConnection')}
                        onPress={handleConnect}
                        size="large"
                        disabled={isLoading}
                        loading={isLoading}
                    />
                    <RoundButton
                        testID="terminal-connect-reject"
                        title={t('terminal.reject')}
                        onPress={handleReject}
                        size="large"
                        display="inverted"
                        disabled={isLoading}
                    />
                </View>
            </ItemGroup>

            {/* Security Notice */}
            <ItemGroup
                title={t('terminal.security')}
                footer={t('terminal.securityFooterDevice')}
            >
                <Item
                    title={t('terminal.clientSideProcessing')}
                    subtitle={t('terminal.linkProcessedOnDevice')}
                    icon={<Icon name="shield-check" size={29} color={theme.colors.state.success.foreground} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>,
    );
}
