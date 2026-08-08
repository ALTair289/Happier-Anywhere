import type { AppUpdateStatusModel, BuildAppUpdateStatusModelParams } from './updateStatusTypes';

function buildDesktopMessage(params: Readonly<{
    availableVersion: string | null;
    error: string | null;
    t: (key: string) => string;
}>): string {
    const error = params.error?.trim();
    if (error) {
        return error;
    }
    if (params.availableVersion) {
        return `${params.t('updateBanner.updateAvailable')}: v${params.availableVersion}`;
    }
    return params.t('updateBanner.updateAvailable');
}

export function buildAppUpdateStatusModel(params: BuildAppUpdateStatusModelParams): AppUpdateStatusModel {
    if (params.nativeUpdateRequired === true) {
        const storeActionLabel = params.platformOs === 'ios'
            ? params.t('updateBanner.tapToUpdateAppStore')
            : params.t('updateBanner.tapToUpdatePlayStore');
        return {
            visible: true,
            kind: 'native-store',
            tone: 'warning',
            iconName: 'download',
            label: params.t('updateBanner.nativeUpdateAvailable'),
            message: params.nativeUpdateUrl
                ? storeActionLabel
                : params.t('updateBanner.nativeUpdateAvailable'),
            actionLabel: params.nativeUpdateUrl
                ? storeActionLabel
                : params.t('common.loading'),
            actionDisabled: !params.nativeUpdateUrl,
        };
    }

    if (params.nativeUpdateUrl) {
        const storeActionLabel = params.platformOs === 'ios'
            ? params.t('updateBanner.tapToUpdateAppStore')
            : params.t('updateBanner.tapToUpdatePlayStore');

        return {
            visible: true,
            kind: 'native-store',
            tone: 'success',
            iconName: 'download',
            label: params.t('updateBanner.nativeUpdateAvailable'),
            message: storeActionLabel,
            actionLabel: storeActionLabel,
            actionDisabled: false,
        };
    }

    if (params.platformOs === 'web' && params.webUi?.updateAvailable) {
        return {
            visible: true, kind: 'web-ui', tone: 'success', iconName: 'arrow-clockwise',
            label: params.t('updateBanner.updateAvailable'), message: params.t('updateBanner.pressToApply'),
            actionLabel: params.t('updateBanner.pressToApply'), actionDisabled: false,
        };
    }

    if (
        params.desktop.status === 'available'
        || params.desktop.status === 'installing'
        || params.desktop.status === 'error'
    ) {
        return {
            visible: true,
            kind: 'desktop',
            tone: params.desktop.status === 'error' ? 'warning' : 'success',
            iconName: params.desktop.status === 'error' ? 'arrow-clockwise' : 'download',
            label: params.t('updateBanner.updateAvailable'),
            message: buildDesktopMessage({
                availableVersion: params.desktop.availableVersion,
                error: params.desktop.error,
                t: params.t,
            }),
            actionLabel: params.desktop.status === 'error'
                ? params.t('common.retry')
                : params.desktop.status === 'installing'
                    ? params.t('common.loading')
                    : params.t('updateBanner.pressToApply'),
            actionDisabled: params.desktop.status === 'installing',
            dismissLabel: params.desktop.status === 'installing' ? undefined : params.t('common.cancel'),
        };
    }

    if (params.ota.isUpdatePending) {
        return {
            visible: true,
            kind: 'ota',
            tone: 'success',
            iconName: 'download',
            label: params.t('updateBanner.updateAvailable'),
            message: params.t('updateBanner.pressToApply'),
            actionLabel: params.t('updateBanner.pressToApply'),
            actionDisabled: false,
        };
    }

    if (params.releaseNotes.hasUnread) {
        return {
            visible: true,
            kind: 'release-notes',
            tone: 'accent',
            iconName: 'sparkle',
            label: params.t('navigation.whatsNew'),
            message: params.t('updateBanner.seeLatest'),
            actionLabel: params.t('updateBanner.seeLatest'),
            actionDisabled: false,
        };
    }

    if (params.changelog.hasUnread) {
        return {
            visible: true,
            kind: 'changelog',
            tone: 'accent',
            iconName: 'sparkle',
            label: params.t('navigation.whatsNew'),
            message: params.t('updateBanner.seeLatest'),
            actionLabel: params.t('updateBanner.seeLatest'),
            actionDisabled: false,
        };
    }

    return { visible: false };
}
