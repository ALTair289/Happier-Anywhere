import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import type { ProviderLocalAuthLaunch } from '@/agents/providers/shared/providerLocalAuthPlugin';
import { Icon } from '@/components/ui/icons/Icon';

export const ProviderAuthenticationActions = React.memo(function ProviderAuthenticationActions(props: Readonly<{
    canCheckNow: boolean;
    canLaunchAuth: boolean;
    hasPrimaryLaunch: boolean;
    hasDeviceCodeLaunch: boolean;
    activeAuthLaunchKind?: ProviderLocalAuthLaunch['kind'] | null;
    loginActionKind: 'login' | 'reauthenticate';
    docsUrl?: string | null;
    onCheckNow: () => void;
    onLaunchAuth: (kind: ProviderLocalAuthLaunch['kind']) => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <>
            {props.canLaunchAuth && props.hasPrimaryLaunch ? (
                <Item
                    testID="settings-provider-auth-login"
                    title={props.loginActionKind === 'reauthenticate'
                        ? t('settingsProviders.authentication.reauthenticateTitle')
                        : t('settingsProviders.authentication.logInTitle')}
                    subtitle={props.loginActionKind === 'reauthenticate'
                        ? t('settingsProviders.authentication.reauthenticateSubtitle')
                        : t('settingsProviders.authentication.logInSubtitle')}
                    icon={<Icon name="sign-in" size={20} color={theme.colors.text.secondary} />}
                    disabled={props.activeAuthLaunchKind != null}
                    onPress={() => props.onLaunchAuth('primary')}
                />
            ) : null}
            {props.canLaunchAuth && props.hasDeviceCodeLaunch ? (
                <Item
                    testID="settings-provider-auth-device-code"
                    title={t('settingsProviders.authentication.deviceCodeTitle')}
                    subtitle={t('settingsProviders.authentication.deviceCodeSubtitle')}
                    icon={<Icon name="key" size={20} color={theme.colors.text.secondary} />}
                    disabled={props.activeAuthLaunchKind != null}
                    onPress={() => props.onLaunchAuth('device_code')}
                />
            ) : null}
            {props.canCheckNow ? (
                <Item
                    testID="settings-provider-auth-check-now"
                    title={t('settingsProviders.authentication.checkNowTitle')}
                    subtitle={t('settingsProviders.authentication.checkNowSubtitle')}
                    icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.text.secondary} />}
                    onPress={props.onCheckNow}
                />
            ) : null}
            {props.docsUrl ? (
                <Item
                    testID="settings-provider-auth-docs-url"
                    title={t('settingsProviders.setupGuideUrlTitle')}
                    subtitle={props.docsUrl}
                    icon={<Icon name="link" size={20} color={theme.colors.text.secondary} />}
                    mode="info"
                    copy={props.docsUrl}
                />
            ) : null}
        </>
    );
});
