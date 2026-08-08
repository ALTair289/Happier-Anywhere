import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { useDesktopUpdater } from '@/desktop/updates/useDesktopUpdater';
import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { useNativeUpdateStatus } from '@/hooks/ui/useNativeUpdate';
import {
    useReleaseNotesLauncher,
    useReleaseNotesUnread,
} from '@/changelog/releaseNotes';
import { tLoose } from '@/text';

import { buildAppUpdateStatusModel } from './buildAppUpdateStatusModel';
import { useWebUiDeploymentFreshness } from './useWebUiDeploymentFreshness';

export function useAppUpdateStatus() {
    const router = useRouter();
    const nativeUpdateStatus = useNativeUpdateStatus();
    const nativeUpdateUrl = nativeUpdateStatus?.updateUrl ?? null;
    const desktop = useDesktopUpdater();
    const ota = useUpdates();
    const changelog = useChangelog();
    const releaseNotes = useReleaseNotesUnread();
    const releaseNotesLauncher = useReleaseNotesLauncher();
    const webUi = useWebUiDeploymentFreshness();

    const model = React.useMemo(
        () => buildAppUpdateStatusModel({
            platformOs: Platform.OS,
            nativeUpdateUrl,
            nativeUpdateRequired: nativeUpdateStatus?.required === true,
            nativeMinimumAppVersion: nativeUpdateStatus?.minimumAppVersion ?? null,
            webUi: { updateAvailable: webUi.updateAvailable },
            desktop: {
                status: desktop.status,
                availableVersion: desktop.availableVersion,
                error: desktop.error,
            },
            ota: {
                isUpdatePending: ota.isUpdatePending,
            },
            releaseNotes: {
                hasUnread: releaseNotes.hasUnread,
            },
            changelog: {
                hasUnread: changelog.hasUnread,
            },
            t: tLoose,
        }),
        [
            changelog.hasUnread,
            desktop.availableVersion,
            desktop.error,
            desktop.status,
            nativeUpdateUrl,
            nativeUpdateStatus?.required,
            nativeUpdateStatus?.minimumAppVersion,
            ota.isUpdatePending,
            releaseNotes.hasUnread,
            webUi.updateAvailable,
        ],
    );

    const runPrimaryAction = React.useCallback(async () => {
        if (!model.visible || model.actionDisabled) {
            return;
        }

        if (model.kind === 'native-store') {
            if (!nativeUpdateUrl) {
                return;
            }
            const supported = await Linking.canOpenURL(nativeUpdateUrl);
            if (supported) {
                await Linking.openURL(nativeUpdateUrl);
            }
            return;
        }

        if (model.kind === 'desktop') {
            if (desktop.status === 'error') {
                await desktop.refresh();
                return;
            }
            await desktop.startInstall();
            return;
        }

        if (model.kind === 'web-ui') {
            webUi.reload();
            return;
        }

        if (model.kind === 'ota') {
            await ota.reloadApp();
            return;
        }

        if (model.kind === 'release-notes') {
            const opened = releaseNotesLauncher.open();
            if (opened) return;
            // Fall through to changelog if the modal could not open (manifest gone, etc.)
        }

        router.push('/changelog');
        setTimeout(() => {
            changelog.markAsRead();
        }, 1000);
    }, [
        changelog,
        desktop,
        model,
        nativeUpdateUrl,
        ota,
        releaseNotesLauncher,
        router,
        webUi,
    ]);

    const dismiss = React.useCallback(() => {
        if (!model.visible || model.kind !== 'desktop') {
            return;
        }
        desktop.dismiss();
    }, [desktop, model]);

    return {
        model,
        runPrimaryAction,
        dismiss,
    };
}
