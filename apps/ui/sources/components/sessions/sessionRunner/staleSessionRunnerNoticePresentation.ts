import type { AgentInputStatusBadgeTone } from '@/components/sessions/agentInput/agentInputContracts';
import type { ActionableStaleSessionRunnerStatus } from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatus';

export type StaleSessionRunnerNoticeTranslationKey =
    | 'session.staleRunner.title'
    | 'session.staleRunner.body'
    | 'session.staleRunner.busyBody'
    | 'session.staleRunner.failureBody'
    | 'session.staleRunner.identityChangedBody'
    | 'session.staleRunner.ineligibleBody'
    | 'session.staleRunner.unsupportedBody'
    | 'session.staleRunner.versionUnknownBody'
    | 'session.staleRunner.restartAction'
    | 'session.staleRunner.restartPendingAction'
    | 'session.staleRunner.statusBadge';

export type StaleSessionRunnerNoticeTranslate = (key: StaleSessionRunnerNoticeTranslationKey) => string;

export type StaleSessionRunnerRestartViewStatus =
    | 'pending'
    | 'restarted'
    | 'already_current'
    | 'runner_identity_changed'
    | 'busy'
    | 'ineligible'
    | 'unsupported_daemon'
    | 'version_unknown'
    | 'failed';

export type StaleSessionRunnerOperationPresentationState = Readonly<{
    status: StaleSessionRunnerRestartViewStatus;
}> | null;

export type StaleSessionRunnerActionPresentation = Readonly<{
    kind: 'restart';
    label: string;
    accessibilityLabel: string;
    testID: string;
    disabled: boolean;
}>;

export type StaleSessionRunnerBannerPresentation = Readonly<{
    testID: string;
    title: string;
    body: string;
    primaryAction: StaleSessionRunnerActionPresentation;
}>;

export type StaleSessionRunnerStatusBadgePresentation = Readonly<{
    key: string;
    label: string;
    testID: string;
    accessibilityLabel: string;
    tone: AgentInputStatusBadgeTone;
}>;

export type StaleSessionRunnerNoticePresentation = Readonly<{
    fingerprint: string;
    banner: StaleSessionRunnerBannerPresentation;
    badge: StaleSessionRunnerStatusBadgePresentation;
}>;

function resolveBodyKey(
    operationStatus: StaleSessionRunnerRestartViewStatus | null,
): StaleSessionRunnerNoticeTranslationKey {
    switch (operationStatus) {
        case 'runner_identity_changed':
            return 'session.staleRunner.identityChangedBody';
        case 'busy':
            return 'session.staleRunner.busyBody';
        case 'ineligible':
            return 'session.staleRunner.ineligibleBody';
        case 'unsupported_daemon':
            return 'session.staleRunner.unsupportedBody';
        case 'version_unknown':
            return 'session.staleRunner.versionUnknownBody';
        case 'failed':
            return 'session.staleRunner.failureBody';
        case 'pending':
        case 'restarted':
        case 'already_current':
        case null:
            return 'session.staleRunner.body';
    }
}

export function buildStaleSessionRunnerNoticePresentation(params: Readonly<{
    status: ActionableStaleSessionRunnerStatus | null;
    operationStatus: StaleSessionRunnerOperationPresentationState;
    translate: StaleSessionRunnerNoticeTranslate;
}>): StaleSessionRunnerNoticePresentation | null {
    if (!params.status) return null;

    const operationStatus = params.operationStatus?.status ?? null;
    if (operationStatus === 'restarted' || operationStatus === 'already_current') return null;

    const actionDisabled = operationStatus === 'pending'
        || operationStatus === 'ineligible'
        || operationStatus === 'unsupported_daemon'
        || operationStatus === 'version_unknown';
    const actionLabel = operationStatus === 'pending'
        ? params.translate('session.staleRunner.restartPendingAction')
        : params.translate('session.staleRunner.restartAction');
    const badgeLabel = params.translate('session.staleRunner.statusBadge');

    return {
        fingerprint: params.status.fingerprint,
        banner: {
            testID: 'session-staleRunner-version',
            title: params.translate('session.staleRunner.title'),
            body: params.translate(resolveBodyKey(operationStatus)),
            primaryAction: {
                kind: 'restart',
                label: actionLabel,
                accessibilityLabel: actionLabel,
                testID: 'session-staleRunner-version-restart',
                disabled: actionDisabled,
            },
        },
        badge: {
            key: 'session-stale-runner',
            label: badgeLabel,
            testID: 'session-staleRunner-status-badge',
            accessibilityLabel: badgeLabel,
            tone: 'warning',
        },
    };
}
