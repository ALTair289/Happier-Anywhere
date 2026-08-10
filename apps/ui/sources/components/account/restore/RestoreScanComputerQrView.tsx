import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { normalizePairingClaimOriginV1 } from '@happier-dev/protocol';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { useAuth } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { generateAuthKeyPair, authQRStart } from '@/auth/flows/qrStart';
import { authQRWait } from '@/auth/flows/qrWait';
import { buildPairingDeepLink, parsePairingDeepLink } from '@/auth/pairing/pairingUrl';
import { encodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { pairingClaimConsume, pairingRequest } from '@/sync/api/account/apiPairingAuth';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    normalizeServerUrl,
    setActiveServerAndSwitch,
    upsertActivateAndSwitchServer,
} from '@/sync/domains/server/activeServerSwitch';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { isLoopbackServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: 560,
        paddingVertical: 28,
    },
    title: {
        fontSize: 18,
        color: theme.colors.text.primary,
        marginBottom: 10,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        lineHeight: 20,
        textAlign: 'center',
        ...Typography.default(),
    },
    statusCard: {
        marginTop: 18,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
    },
    codeLabel: {
        marginTop: 12,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    codeValue: {
        marginTop: 6,
        fontSize: 18,
        color: theme.colors.text.primary,
        letterSpacing: 1,
        ...Typography.mono(),
    },
    footer: {
        marginTop: 18,
        alignItems: 'center',
        width: '100%',
        gap: 12,
    },
    footerButton: {
        width: '100%',
        maxWidth: 360,
    },
}));

function resolveDeviceLabel(): string | null {
    const name = Constants.deviceName ?? '';
    const trimmed = String(name).trim();
    if (trimmed) return trimmed;
    if (Platform.OS === 'ios') return 'iPhone';
    if (Platform.OS === 'android') return 'Android';
    return null;
}

type OwnedClaimServerSwitch = Readonly<{
    operationGeneration: number;
    priorServerId: string;
    targetServerId: string;
    targetGeneration: number;
}>;

export const RestoreScanComputerQrView = React.memo(function RestoreScanComputerQrView() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const isFocused = useIsFocused();
    const auth = useAuth();
    const pairingDecision = useFeatureDecision('auth.pairing.desktopQrMobileScan');
    const pairingState = pairingDecision?.state ?? 'unknown';

    const [phase, setPhase] = React.useState<'idle' | 'requesting' | 'waiting'>('idle');
    const [confirmCode, setConfirmCode] = React.useState<string | null>(null);
    const [waitingDots, setWaitingDots] = React.useState(0);
    const mountedRef = React.useRef(true);
    const operationGenerationRef = React.useRef(0);
    const activeOperationRef = React.useRef<number | null>(null);
    const ownedClaimServerSwitchRef = React.useRef<OwnedClaimServerSwitch | null>(null);

    const rollbackOwnedClaimServerSwitch = React.useCallback(async (expectedOperationGeneration: number) => {
        const owned = ownedClaimServerSwitchRef.current;
        if (!owned || owned.operationGeneration !== expectedOperationGeneration) return;

        const current = getActiveServerSnapshot();
        if (
            current.serverId !== owned.targetServerId
            || current.generation !== owned.targetGeneration
        ) {
            ownedClaimServerSwitchRef.current = null;
            return;
        }

        ownedClaimServerSwitchRef.current = null;
        await setActiveServerAndSwitch({
            serverId: owned.priorServerId,
            scope: 'device',
            refreshAuth: auth.refreshFromActiveServer,
        });
    }, [auth.refreshFromActiveServer]);

    const processPairingLink = React.useCallback(
        async (rawUrl: string) => {
            if (activeOperationRef.current !== null) return;
            const operationGeneration = operationGenerationRef.current + 1;
            operationGenerationRef.current = operationGeneration;
            activeOperationRef.current = operationGeneration;
            const isCurrentOperation = () =>
                mountedRef.current && activeOperationRef.current === operationGeneration;

            const parsed = parsePairingDeepLink(rawUrl.trim());
            if (!parsed) {
                try {
                    await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'));
                } finally {
                    if (activeOperationRef.current === operationGeneration) {
                        activeOperationRef.current = null;
                    }
                }
                return;
            }

            setPhase('requesting');
            setConfirmCode(null);

            try {
                const priorServer = getActiveServerSnapshot();
                const activeServerUrl = normalizeServerUrl(priorServer.serverUrl);
                const activeServerUrlIsLoopback = activeServerUrl ? isLoopbackServerUrl(activeServerUrl) : false;
                const isClaimV1 = 'claimId' in parsed;
                let claimTargetUrl: string | null = null;

                if (isClaimV1) {
                    const target = resolveEffectiveServerUrlOverride({
                        requestedServerUrl: parsed.origin,
                        activeServerUrl,
                    });
                    const activeClaimOrigin = normalizePairingClaimOriginV1(activeServerUrl ?? '');
                    claimTargetUrl = target ?? (activeClaimOrigin === parsed.origin ? parsed.origin : null);
                    if (claimTargetUrl !== parsed.origin) throw new Error('Claim origin is not an allowed target');
                } else if (parsed.serverUrl) {
                    const target = resolveEffectiveServerUrlOverride({
                        requestedServerUrl: parsed.serverUrl,
                        activeServerUrl,
                    });
                    if (target) {
                        await upsertActivateAndSwitchServer({
                            serverUrl: target,
                            source: 'url',
                            scope: 'device',
                            refreshAuth: auth.refreshFromActiveServer,
                        });
                    }
                }
                if (!isCurrentOperation()) return;

                const keypair = generateAuthKeyPair();
                const started = await authQRStart(keypair, {
                    ...(claimTargetUrl ? { serverUrl: claimTargetUrl } : null),
                    shouldCancel: () => !isCurrentOperation(),
                });
                if (!isCurrentOperation()) return;
                if (!started) {
                    await Modal.alertAsync(t('common.error'), t('errors.authenticationFailed'));
                    if (isCurrentOperation()) setPhase('idle');
                    return;
                }

                const publicKey = encodeBase64(keypair.publicKey);
                const deviceLabel = resolveDeviceLabel() ?? undefined;
                const pairingRes = isClaimV1
                    ? await pairingClaimConsume({
                        claimId: parsed.claimId,
                        origin: parsed.origin,
                        publicKey,
                        deviceLabel,
                    })
                    : await pairingRequest({
                        pairId: parsed.pairId,
                        secret: parsed.secret,
                        publicKey,
                        deviceLabel,
                    });
                if (!isCurrentOperation()) return;

                if (!pairingRes.ok) {
                    if (pairingRes.reason === 'not_found') {
                        if (isClaimV1) {
                            await Modal.alertAsync(t('modals.authRequestExpired'), t('modals.authRequestExpiredDescription'));
                        } else {
                            const requestedLoopback = parsed.serverUrl ? isLoopbackServerUrl(parsed.serverUrl) : false;
                            const showServerUrlNotEmbeddedHint = parsed.serverUrl == null || (requestedLoopback && !activeServerUrlIsLoopback);
                            if (showServerUrlNotEmbeddedHint) {
                                await Modal.alertAsync(t('connect.serverUrlNotEmbeddedTitle'), t('connect.serverUrlNotEmbeddedBody'));
                            } else {
                                await Modal.alertAsync(t('modals.authRequestExpired'), t('modals.authRequestExpiredDescription'));
                            }
                        }
                    } else if (!isClaimV1 && pairingRes.reason === 'already_requested') {
                        await Modal.alertAsync(
                            t('connect.pairingAlreadyRequestedTitle'),
                            t('connect.pairingAlreadyRequestedBody'),
                        );
                    } else {
                        await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
                    }
                    if (isCurrentOperation()) setPhase('idle');
                    return;
                }

                setConfirmCode(pairingRes.data.confirmCode);

                setPhase('waiting');
                const credentials = await authQRWait(
                    keypair,
                    (dots) => {
                        if (isCurrentOperation()) setWaitingDots(dots);
                    },
                    () => !isCurrentOperation(),
                    claimTargetUrl ? { serverUrl: claimTargetUrl } : undefined,
                );

                if (credentials && isCurrentOperation()) {
                    if (isClaimV1 && claimTargetUrl) {
                        const currentBeforeSwitch = getActiveServerSnapshot();
                        if (
                            currentBeforeSwitch.generation !== priorServer.generation
                            || currentBeforeSwitch.serverId !== priorServer.serverId
                            || normalizeServerUrl(currentBeforeSwitch.serverUrl) !== activeServerUrl
                        ) {
                            setPhase('idle');
                            return;
                        }

                        const secretString = encodeBase64(credentials.secret, 'base64url');
                        const credentialsStored = await TokenStorage.setCredentialsForServerUrl(
                            { token: credentials.token, secret: secretString },
                            claimTargetUrl,
                        );
                        if (!credentialsStored) {
                            throw new Error('Failed to store claim credentials for the target server');
                        }
                        if (!isCurrentOperation()) return;

                        const currentAfterCredentialStore = getActiveServerSnapshot();
                        if (
                            currentAfterCredentialStore.generation !== priorServer.generation
                            || currentAfterCredentialStore.serverId !== priorServer.serverId
                            || normalizeServerUrl(currentAfterCredentialStore.serverUrl) !== activeServerUrl
                        ) {
                            setPhase('idle');
                            return;
                        }

                        if (normalizePairingClaimOriginV1(currentAfterCredentialStore.serverUrl) !== claimTargetUrl) {
                            const switchPromise = upsertActivateAndSwitchServer({
                                serverUrl: claimTargetUrl,
                                source: 'url',
                                scope: 'device',
                                refreshAuth: null,
                            });
                            const operationTarget = getActiveServerSnapshot();
                            if (
                                normalizePairingClaimOriginV1(operationTarget.serverUrl) === claimTargetUrl
                                && (
                                    operationTarget.serverId !== priorServer.serverId
                                    || operationTarget.generation !== priorServer.generation
                                )
                            ) {
                                ownedClaimServerSwitchRef.current = {
                                    operationGeneration,
                                    priorServerId: priorServer.serverId,
                                    targetServerId: operationTarget.serverId,
                                    targetGeneration: operationTarget.generation,
                                };
                            }
                            try {
                                await switchPromise;
                            } catch (error) {
                                await rollbackOwnedClaimServerSwitch(operationGeneration);
                                throw error;
                            }
                        }
                        if (!isCurrentOperation()) {
                            await rollbackOwnedClaimServerSwitch(operationGeneration);
                            return;
                        }

                        const targetSnapshot = getActiveServerSnapshot();
                        if (normalizePairingClaimOriginV1(targetSnapshot.serverUrl) !== claimTargetUrl) {
                            throw new Error('Claim target switch did not reach the requested origin');
                        }

                        await auth.refreshFromActiveServer();
                        const currentAfterLogin = getActiveServerSnapshot();
                        if (
                            !isCurrentOperation()
                            || currentAfterLogin.generation !== targetSnapshot.generation
                            || currentAfterLogin.serverId !== targetSnapshot.serverId
                        ) {
                            await rollbackOwnedClaimServerSwitch(operationGeneration);
                            return;
                        }
                        if (ownedClaimServerSwitchRef.current?.operationGeneration === operationGeneration) {
                            ownedClaimServerSwitchRef.current = null;
                        }
                    } else {
                        const secretString = encodeBase64(credentials.secret, 'base64url');
                        await auth.login(credentials.token, secretString);
                    }
                    if (!isCurrentOperation()) return;
                    router.replace('/');
                } else if (isCurrentOperation()) {
                    await Modal.alertAsync(t('common.error'), t('errors.authenticationFailed'));
                    if (isCurrentOperation()) setPhase('idle');
                }
            } catch {
                await rollbackOwnedClaimServerSwitch(operationGeneration).catch(() => {});
                if (isCurrentOperation()) {
                    await Modal.alertAsync(t('common.error'), t('errors.authenticationFailed'));
                    if (isCurrentOperation()) setPhase('idle');
                }
            } finally {
                await rollbackOwnedClaimServerSwitch(operationGeneration).catch(() => {});
                if (activeOperationRef.current === operationGeneration) {
                    activeOperationRef.current = null;
                }
            }
        },
        [auth, rollbackOwnedClaimServerSwitch, router],
    );

    React.useEffect(() => {
        if (isFocused) return;
        const activeOperationGeneration = activeOperationRef.current;
        operationGenerationRef.current += 1;
        activeOperationRef.current = null;
        setPhase('idle');
        setConfirmCode(null);
        if (activeOperationGeneration !== null) {
            void rollbackOwnedClaimServerSwitch(activeOperationGeneration).catch(() => {});
        }
    }, [isFocused, rollbackOwnedClaimServerSwitch]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            const activeOperationGeneration = activeOperationRef.current;
            operationGenerationRef.current += 1;
            activeOperationRef.current = null;
            if (activeOperationGeneration !== null) {
                void rollbackOwnedClaimServerSwitch(activeOperationGeneration).catch(() => {});
            }
        };
    }, [rollbackOwnedClaimServerSwitch]);

    const waitingSuffix = phase === 'waiting' ? '.'.repeat(waitingDots % 4) : '';
    const statusText =
        phase === 'idle'
            ? t('connect.scanComputerQrInstructions')
                : phase === 'requesting'
                    ? t('common.loading')
                    : `${t('connect.waitingForApproval')}${waitingSuffix}`;

    if (pairingState === 'unknown') {
        return (
            <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
                <View style={styles.container}>
                    <View style={styles.contentWrapper}>
                        <Text style={styles.title}>{t('connect.restoreAccount')}</Text>
                        <Text style={styles.subtitle}>{t('common.loading')}</Text>

                        <View style={styles.statusCard}>
                            <ActivitySpinner size="small" color={theme.colors.text.primary} />
                        </View>

                        <View style={styles.footer}>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-open-manual"
                                    size="small"
                                    title={t('connect.restoreWithSecretKeyInstead')}
                                    display="inverted"
                                    action={async () => {
                                        router.push('/restore/manual');
                                    }}
                                />
                            </View>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-show-qr-instead"
                                    size="small"
                                    title={t('connect.showQrInstead')}
                                    display="inverted"
                                    action={async () => {
                                        router.push('/restore/show-qr');
                                    }}
                                />
                            </View>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-scan-cancel"
                                    size="small"
                                    title={t('common.back')}
                                    display="inverted"
                                    action={async () => {
                                        router.back();
                                    }}
                                />
                            </View>
                        </View>
                    </View>
                </View>
            </ScrollView>
        );
    }

    if (pairingState !== 'enabled') {
        return (
            <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
                <View style={styles.container}>
                    <View style={styles.contentWrapper}>
                        <Text style={styles.title}>{t('connect.restoreAccount')}</Text>
                        <Text style={styles.subtitle}>{t('connect.scanComputerQrUnavailableBody')}</Text>

                        <View style={styles.statusCard}>
                            <Text style={styles.codeLabel}>{t('connect.scanComputerQrUnavailableTitle')}</Text>
                        </View>

                        <View style={styles.footer}>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-open-manual"
                                    size="small"
                                    title={t('connect.restoreWithSecretKeyInstead')}
                                    display="inverted"
                                    action={async () => {
                                        router.push('/restore/manual');
                                    }}
                                />
                            </View>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-show-qr-instead"
                                    size="small"
                                    title={t('connect.showQrInstead')}
                                    display="inverted"
                                    action={async () => {
                                        router.push('/restore/show-qr');
                                    }}
                                />
                            </View>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-scan-cancel"
                                    size="small"
                                    title={t('common.back')}
                                    display="inverted"
                                    action={async () => {
                                        router.back();
                                    }}
                                />
                            </View>
                        </View>
                    </View>
                </View>
            </ScrollView>
        );
    }

    if (phase === 'idle') {
        return (
            <QrCodeScannerView
                active={isFocused}
                testIDPrefix="restore-scan"
                title={t('connect.restoreAccount')}
                subtitle={t('connect.scanComputerQrInstructions')}
                permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
                onCancel={() => router.back()}
                onScan={async (data) => {
                    if (typeof data === 'string' && data.trim()) {
                        await processPairingLink(data.trim());
                    }
                }}
                footer={
                    <>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-enter-pairing-link"
                                size="normal"
                                title={t('connect.enterUrlManually')}
                                action={async () => {
                                    const url = await Modal.prompt(
                                        t('connect.enterUrlManually'),
                                        undefined,
                                        {
                                            placeholder: buildPairingDeepLink({
                                                pairId: '…',
                                                secret: '…',
                                                serverUrl: getActiveServerUrl(),
                                            }),
                                            confirmText: t('common.continue'),
                                            cancelText: t('common.cancel'),
                                        },
                                    );
                                    if (typeof url === 'string' && url.trim()) {
                                        await processPairingLink(url.trim());
                                    }
                                }}
                            />
                        </View>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    router.push('/restore/manual');
                                }}
                            />
                        </View>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-show-qr-instead"
                                size="small"
                                title={t('connect.showQrInstead')}
                                display="inverted"
                                action={async () => {
                                    router.push('/restore/show-qr');
                                }}
                            />
                        </View>
                    </>
                }
            />
        );
    }

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <Text style={styles.title}>{t('connect.restoreAccount')}</Text>
                    <Text style={styles.subtitle}>{statusText}</Text>

                    <View style={styles.statusCard}>
                        <ActivitySpinner size="small" color={theme.colors.text.primary} />
                        {confirmCode ? (
                            <>
                                <Text style={styles.codeLabel}>{t('connect.confirmCodeLabel')}</Text>
                                <Text style={styles.codeValue}>{confirmCode}</Text>
                            </>
                        ) : null}
                    </View>

                    <View style={styles.footer}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-enter-pairing-link"
                                size="small"
                                title={t('connect.enterUrlManually')}
                                display="inverted"
                                action={async () => {
                                    const url = await Modal.prompt(
                                        t('connect.enterUrlManually'),
                                        undefined,
                                        {
                                            placeholder: buildPairingDeepLink({
                                                pairId: '…',
                                                secret: '…',
                                                serverUrl: getActiveServerUrl(),
                                            }),
                                            confirmText: t('common.continue'),
                                            cancelText: t('common.cancel'),
                                        },
                                    );
                                    if (typeof url === 'string' && url.trim()) {
                                        await processPairingLink(url.trim());
                                    }
                                }}
                            />
                        </View>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    router.push('/restore/manual');
                                }}
                            />
                        </View>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-show-qr-instead"
                                size="small"
                                title={t('connect.showQrInstead')}
                                display="inverted"
                                action={async () => {
                                    router.push('/restore/show-qr');
                                }}
                            />
                        </View>
                    </View>
                </View>
            </View>
        </ScrollView>
    );
});
