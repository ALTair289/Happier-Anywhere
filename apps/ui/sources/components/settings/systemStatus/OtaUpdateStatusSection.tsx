import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { useNativeUpdate } from '@/hooks/ui/useNativeUpdate';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

function toErrorMessage(error: unknown): string | null {
    if (error instanceof Error) {
        const message = error.message.trim();
        return message || null;
    }

    if (typeof error === 'string') {
        const message = error.trim();
        return message || null;
    }

    return null;
}

function formatLastChecked(value: Date | undefined): string {
    return value instanceof Date ? value.toLocaleString() : t('status.unknown');
}

export const OtaUpdateStatusSection = React.memo(function OtaUpdateStatusSection() {
    const { theme } = useUnistyles();
    const updateUrl = useNativeUpdate();
    const {
        otaUpdatesEnabled,
        isChecking,
        isDownloading,
        isRestarting,
        isUpdatePending,
        downloadProgress,
        checkError,
        downloadError,
        lastCheckForUpdateTimeSinceRestart,
        checkForUpdates,
        reloadApp,
    } = useUpdates();

    const progressPercent = typeof downloadProgress === 'number'
        ? `${Math.max(0, Math.min(100, Math.round(downloadProgress * 100)))}%`
        : null;
    const errorMessage = toErrorMessage(downloadError) ?? toErrorMessage(checkError);

    const otaStatusDetail = (() => {
        if (!otaUpdatesEnabled) return t('systemStatus.updates.disabled');
        if (isRestarting) return t('systemStatus.updates.applying');
        if (isUpdatePending) return t('systemStatus.updates.readyToApply');
        if (isDownloading) {
            return progressPercent
                ? t('systemStatus.updates.downloadingProgress', { progress: progressPercent })
                : t('systemStatus.updates.downloading');
        }
        if (isChecking) return t('systemStatus.updates.checking');
        if (errorMessage) return t('systemStatus.updates.error');
        if (lastCheckForUpdateTimeSinceRestart instanceof Date) return t('systemStatus.updates.upToDate');
        return t('systemStatus.updates.unknown');
    })();

    const otaStatusSubtitle = errorMessage
        ? <Text style={{ color: theme.colors.text.secondary }}>{errorMessage}</Text>
        : undefined;

    const openStoreUpdate = React.useCallback(async () => {
        if (!updateUrl) return;
        const supported = await Linking.canOpenURL(updateUrl);
        if (!supported) return;
        await Linking.openURL(updateUrl);
    }, [updateUrl]);

    const runOtaAction = React.useCallback(() => {
        if (!otaUpdatesEnabled) return;
        if (isUpdatePending) {
            void reloadApp();
            return;
        }
        void checkForUpdates();
    }, [checkForUpdates, isUpdatePending, otaUpdatesEnabled, reloadApp]);

    return (
        <ItemGroup title={t('systemStatus.sections.updates')}>
            <Item
                title={t('systemStatus.updates.otaStatus')}
                detail={otaStatusDetail}
                subtitle={otaStatusSubtitle}
                mode="info"
                icon={<Icon name="cloud-arrow-down" size={24} color={theme.colors.accent.blue} />}
            />
            <Item
                title={t('systemStatus.updates.lastChecked')}
                detail={formatLastChecked(lastCheckForUpdateTimeSinceRestart)}
                mode="info"
                icon={<Icon name="clock" size={24} color={theme.colors.accent.orange} />}
            />
            {updateUrl ? (
                <Item
                    title={t('systemStatus.updates.openStore')}
                    detail={t('systemStatus.updates.available')}
                    subtitle={Platform.OS === 'ios' ? t('updateBanner.tapToUpdateAppStore') : t('updateBanner.tapToUpdatePlayStore')}
                    onPress={openStoreUpdate}
                    icon={<Icon name="download" size={24} color={theme.colors.state.success.foreground} />}
                />
            ) : null}
            {otaUpdatesEnabled ? (
                <Item
                    title={isUpdatePending ? t('systemStatus.updates.applyNow') : t('systemStatus.updates.checkNow')}
                    subtitle={isUpdatePending ? t('updateBanner.pressToApply') : t('systemStatus.updates.checkNowSubtitle')}
                    onPress={runOtaAction}
                    loading={isUpdatePending ? isRestarting : (isChecking || isDownloading)}
                    disabled={isUpdatePending ? isRestarting : (isChecking || isDownloading)}
                    showChevron={false}
                    icon={<Icon name={isUpdatePending ? 'arrows-clockwise' : 'arrow-clockwise'} size={24} color={theme.colors.accent.indigo} />}
                />
            ) : null}
        </ItemGroup>
    );
});
