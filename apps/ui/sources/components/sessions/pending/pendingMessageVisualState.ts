import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { TranslationKeyNoParams } from '@/text';

export type PendingMessageVisualStateKind =
    | 'saving'
    | 'queued'
    | 'delivering'
    | 'materializing'
    | 'blocked';

export type PendingDeliveryBlockedReasonPresentation = Readonly<{
    labelKey: TranslationKeyNoParams;
    isUnknown: boolean;
}>;

export type PendingMessageVisualState = Readonly<{
    kind: PendingMessageVisualStateKind;
    showSpinner: boolean;
    iconName: 'cloud-upload-outline' | 'time-outline' | 'navigate-outline' | 'alert-circle-outline';
    deliveryBlockedReason?: PendingMessage['pendingDeliveryBlockedReason'];
    deliveryBlockedPresentation?: PendingDeliveryBlockedReasonPresentation;
}>;

const blockedReasonLabelKeys = {
    terminal_composer_draft: 'session.pendingMessages.deliveryBlockedReasons.terminalComposerDraft',
    runtime_config_blocked: 'session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked',
    provider_acceptance_timeout: 'session.pendingMessages.deliveryBlockedReasons.providerAcceptanceTimeout',
    provider_unavailable_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerUnavailableBeforeAcceptance',
    ambiguous_terminal_delivery: 'session.pendingMessages.deliveryBlockedReasons.ambiguousTerminalDelivery',
    terminal_host_unreachable: 'session.pendingMessages.deliveryBlockedReasons.terminalHostUnreachable',
    runtime_disposed_before_delivery: 'session.pendingMessages.deliveryBlockedReasons.runtimeDisposedBeforeDelivery',
    invalid_prompt_text: 'session.pendingMessages.deliveryBlockedReasons.invalidPromptText',
    manual_user_handled: 'session.pendingMessages.deliveryBlockedReasons.manualUserHandled',
    attempt_expired_before_write: 'session.pendingMessages.deliveryBlockedReasons.attemptExpiredBeforeWrite',
    provider_rejected_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerRejectedBeforeAcceptance',
    payload_too_large: 'session.pendingMessages.deliveryBlockedReasons.payloadTooLarge',
    unknown: 'session.pendingMessages.deliveryBlockedReasons.unknown',
} satisfies Record<NonNullable<PendingMessage['pendingDeliveryBlockedReason']>, TranslationKeyNoParams>;

export function getPendingDeliveryBlockedReasonPresentation(
    message: Pick<PendingMessage, 'pendingDeliveryBlockedReason' | 'pendingDeliveryBlockedReasonRaw' | 'pendingDeliveryStatusRaw'>,
): PendingDeliveryBlockedReasonPresentation {
    const reason = message.pendingDeliveryBlockedReason ?? 'unknown';
    return {
        labelKey: blockedReasonLabelKeys[reason] ?? blockedReasonLabelKeys.unknown,
        isUnknown:
            reason === 'unknown'
            || typeof message.pendingDeliveryBlockedReasonRaw === 'string'
            || typeof message.pendingDeliveryStatusRaw === 'string',
    };
}

export function getPendingMessageVisualState(
    message: PendingMessage,
    options?: Readonly<{ materializingLocalIds?: ReadonlySet<string> }>,
): PendingMessageVisualState {
    const localId = typeof message.localId === 'string' ? message.localId : message.id;
    if (options?.materializingLocalIds?.has(localId)) {
        return {
            kind: 'materializing',
            showSpinner: true,
            iconName: 'navigate-outline',
        };
    }

    if (message.source === 'local_outbound' && message.deliveryStatus !== 'accepted') {
        return {
            kind: 'saving',
            showSpinner: true,
            iconName: 'cloud-upload-outline',
        };
    }

    if (message.pendingDeliveryStatus === 'blocked') {
        return {
            kind: 'blocked',
            showSpinner: false,
            iconName: 'alert-circle-outline',
            deliveryBlockedReason: message.pendingDeliveryBlockedReason ?? 'unknown',
            deliveryBlockedPresentation: getPendingDeliveryBlockedReasonPresentation(message),
        };
    }

    if (message.pendingDeliveryStatus === 'server_delivering') {
        return {
            kind: 'delivering',
            showSpinner: true,
            iconName: 'navigate-outline',
        };
    }

    return {
        kind: 'queued',
        showSpinner: false,
        iconName: 'time-outline',
    };
}
