import React, { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { normalizeSecretKey } from '@/auth/recovery/secretKeyBackup';
import { authGetToken } from '@/auth/flows/getToken';
import { decodeBase64 } from '@/encryption/base64';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text, TextInput } from '@/components/ui/text/Text';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell';
import { Icon } from '@/components/ui/icons/Icon';

const ignoreBrandHeroGetStarted = () => undefined;

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: Math.min(560, layout.maxWidth),
        paddingVertical: 28,
    },
    noticeCard: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
        marginBottom: 16,
    },
    noticeText: {
        fontSize: 15,
        color: theme.colors.text.secondary,
        lineHeight: 21,
        ...Typography.default(),
    },
    secondInstructionText: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        marginBottom: 20,
        marginTop: 30,
        ...Typography.default(),
    },
    qrInstructions: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        marginBottom: 16,
        lineHeight: 22,
        textAlign: 'center',
        ...Typography.default(),
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderColor: theme.colors.border.default,
        borderWidth: 1,
        padding: 16,
        paddingRight: 52,
        borderRadius: 14,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 14,
        minHeight: 54,
        color: theme.colors.input.text,
    },
    textInputWrapper: {
        width: '100%',
        position: 'relative',
        marginBottom: 24,
    },
    revealButton: {
        position: 'absolute',
        right: 10,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 8,
    },
}));

export default function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const [restoreKey, setRestoreKey] = useState('');
    const [revealed, setRevealed] = useState(false);

    const handleRestore = async () => {
        const trimmedKey = restoreKey.trim();

        if (!trimmedKey) {
            Modal.alert(t('common.error'), t('connect.enterSecretKey'));
            return;
        }

        try {
            // Normalize the key (handles both base64url and formatted input)
            const normalizedKey = normalizeSecretKey(trimmedKey);

            // Validate the secret key format
            const secretBytes = decodeBase64(normalizedKey, 'base64url');
            if (secretBytes.length !== 32) {
                throw new Error('Invalid secret key length');
            }

            // Get token from secret
            const token = await authGetToken(secretBytes);
            if (!token) {
                throw new Error('Failed to authenticate with provided key');
            }

            // Login with new credentials
            await auth.login(token, normalizedKey);

            // Dismiss the restore stack instead of replacing inside it; nested replace can race during auth bootstrap.
            router.dismissTo('/');

        } catch (error) {
            Modal.alert(t('common.error'), t('connect.invalidSecretKey'));
        }
    };

    const content = (
        <ScrollView testID="restore-route-content" style={styles.scrollView}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <View style={styles.noticeCard}>
                        <Text style={styles.noticeText}>{t('connect.restoreWithSecretKeyDescription')}</Text>
                    </View>

                    <View style={styles.textInputWrapper}>
                        <TextInput
                            testID="restore-manual-secret-input"
                            style={styles.textInput}
                            placeholder={t('connect.secretKeyPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={restoreKey}
                            onChangeText={setRestoreKey}
                            secureTextEntry={!revealed}
                            // Secret keys may be pasted in base64url (case-sensitive) or the grouped base32 backup format.
                            // Auto-capitalization would corrupt base64url keys, so keep it disabled.
                            autoCapitalize="none"
                            autoCorrect={false}
                            multiline={false}
                        />

                        <Pressable
                            testID="restore-manual-secret-reveal"
                            accessibilityRole="button"
                            accessibilityLabel={revealed ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                            onPress={() => setRevealed((v) => !v)}
                            style={styles.revealButton}
                            hitSlop={10}
                        >
                            <Icon
                                name={revealed ? 'eye-slash' : 'eye'}
                                size={20}
                                color={theme.colors.text.secondary}
                            />
                        </Pressable>
                    </View>

                    <RoundButton
                        testID="restore-manual-submit"
                        title={t('connect.restoreAccount')}
                        action={handleRestore}
                    />
                </View>
            </View>
        </ScrollView>
    );

    if (auth.isAuthenticated) {
        return content;
    }

    return (
        <UnauthenticatedSplitShell
            stepId="restore-manual"
            isWelcomeStep={false}
            allowMobileBrandHero={false}
            onOpenRelayCustomFlow={() => router.push('/setup')}
            onBrandHeroGetStarted={ignoreBrandHeroGetStarted}
            onBack={() => router.back()}
            testID="unauth-shell-route-restore-manual"
        >
            {content}
        </UnauthenticatedSplitShell>
    );
}
