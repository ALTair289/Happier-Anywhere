import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { TranslationKeyNoParams } from '@/text';

export type PendingMessageVisualStateKind =
    | 'saving'
    | 'send_unconfirmed'
    | 'send_failed'
    | 'cancelling'
    | 'cancel_failed'
    | 'queued'
    | 'queued_behind_turn'
    | 'delivering'
    | 'delivery_uncertain'
    | 'materializing'
    | 'blocked';

export type PendingDeliveryBlockedReasonPresentation = Readonly<{
    labelKey: TranslationKeyNoParams;
    isUnknown: boolean;
}>;

export type PendingMessageQueuedBehindTurnPresentation = Readonly<{
    reason:
        | 'waiting_for_predecessor'
        | 'waiting_for_foreground_turn'
        | 'waiting_for_runtime_activity'
        | 'runtime_activity_unknown'
        | 'waiting_for_runtime';
    /** Turn-start / meaningful-activity timestamp used to render the elapsed "running Xm" copy. */
    turnStartedAtMs?: number;
}>;

/**
 * Presentation snapshot of the session's runtime activity, joined here so the wait chip
 * ("Waiting for the current task to finish") is DERIVED from the canonical working state rather
 * than a new wire status. When the session is not working, this input is absent/`isWorking:false`
 * and behavior is unchanged.
 */
export type PendingMessageSessionRuntimeInput = Readonly<{
    isWorking: boolean;
    runtimeReachable?: boolean;
    runtimeActivityState?: 'idle' | 'active' | 'unknown';
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
    deliveryTiming?: 'after_foreground_ready' | 'after_runtime_idle';
    turnStartedAtMs?: number;
}>;

export type PendingMessageVisualState = Readonly<{
    kind: PendingMessageVisualStateKind;
    showSpinner: boolean;
    iconName: 'cloud-upload-outline' | 'time-outline' | 'navigate-outline' | 'alert-circle-outline';
    deliveryBlockedReason?: PendingMessage['pendingDeliveryBlockedReason'];
    deliveryBlockedPresentation?: PendingDeliveryBlockedReasonPresentation;
    queuedBehindTurn?: PendingMessageQueuedBehindTurnPresentation;
}>;

const blockedReasonLabelKeys = {
    terminal_composer_draft: 'session.pendingMessages.deliveryBlockedReasons.terminalComposerDraft',
    runtime_config_blocked: 'session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked',
    provider_unavailable_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerUnavailableBeforeAcceptance',
    ambiguous_terminal_delivery: 'session.pendingMessages.deliveryBlockedReasons.ambiguousTerminalDelivery',
    delivery_outcome_uncertain: 'session.pendingMessages.deliveryBlockedReasons.ambiguousTerminalDelivery',
    terminal_host_unreachable: 'session.pendingMessages.deliveryBlockedReasons.terminalHostUnreachable',
    runtime_disposed_before_delivery: 'session.pendingMessages.deliveryBlockedReasons.runtimeDisposedBeforeDelivery',
    invalid_prompt_text: 'session.pendingMessages.deliveryBlockedReasons.invalidPromptText',
    manual_user_handled: 'session.pendingMessages.deliveryBlockedReasons.manualUserHandled',
    attempt_expired_before_write: 'session.pendingMessages.deliveryBlockedReasons.attemptExpiredBeforeWrite',
    provider_rejected_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerRejectedBeforeAcceptance',
    steering_unavailable: 'session.pendingMessages.deliveryBlockedReasons.steeringUnavailable',
    unsupported_action: 'session.pendingMessages.deliveryBlockedReasons.unsupportedAction',
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

export function isPendingMessageProviderDeliveryInFlight(message: PendingMessage): boolean {
    return message.pendingDeliveryStatus === 'server_delivering';
}

export function getPendingMessageVisualState(
    message: PendingMessage,
    options?: Readonly<{
        materializingLocalIds?: ReadonlySet<string>;
        hasEarlierPendingPredecessor?: boolean;
        hasProviderDeliveryInFlight?: boolean;
        sessionRuntime?: PendingMessageSessionRuntimeInput;
    }>,
): PendingMessageVisualState {
    const localId = typeof message.localId === 'string' ? message.localId : message.id;
    if (options?.materializingLocalIds?.has(localId)) {
        return {
            kind: 'materializing',
            showSpinner: true,
            iconName: 'navigate-outline',
        };
    }

    // Local send-acknowledgment state owns presentation only before durable Pending custody is
    // proven. Once a server projection or accepted local projection exists, durable Queue state
    // outranks any stale local failure marker and must never regress to “Not sent”.
    if (message.pendingOutboxOperation === 'cancel') {
        return message.sendState === 'failed'
            ? { kind: 'cancel_failed', showSpinner: false, iconName: 'alert-circle-outline' }
            : { kind: 'cancelling', showSpinner: true, iconName: 'time-outline' };
    }
    const isPersistedQuarantine = message.pendingOutboxQuarantineReason !== undefined;
    const isRetainedByDurablePendingOwner = message.source === 'server_pending'
        || message.deliveryStatus === 'accepted'
        || isPersistedQuarantine;
    if (!isRetainedByDurablePendingOwner && message.sendState === 'failed') {
        return {
            kind: 'send_failed',
            showSpinner: false,
            iconName: 'alert-circle-outline',
        };
    }
    if (!isRetainedByDurablePendingOwner && message.sendState === 'unconfirmed') {
        return {
            kind: 'send_unconfirmed',
            showSpinner: true,
            iconName: 'cloud-upload-outline',
        };
    }

    if (message.source === 'local_outbound' && message.deliveryStatus !== 'accepted' && !isPersistedQuarantine) {
        return {
            kind: 'saving',
            showSpinner: true,
            iconName: 'cloud-upload-outline',
        };
    }

    if (message.pendingDeliveryStatus === 'blocked') {
        const blockedState = {
            showSpinner: false,
            deliveryBlockedReason: message.pendingDeliveryBlockedReason ?? 'unknown',
            deliveryBlockedPresentation: getPendingDeliveryBlockedReasonPresentation(message),
        } as const;
        if (
            message.pendingDeliveryBlockedReason === 'ambiguous_terminal_delivery'
            || message.pendingDeliveryBlockedReason === 'delivery_outcome_uncertain'
        ) {
            return {
                ...blockedState,
                kind: 'delivery_uncertain',
                iconName: 'alert-circle-outline',
            };
        }
        return {
            ...blockedState,
            kind: 'blocked',
            iconName: 'alert-circle-outline',
        };
    }

    if (message.pendingDeliveryStatus === 'external_handoff') {
        return {
            kind: 'delivering',
            showSpinner: false,
            iconName: 'navigate-outline',
        };
    }

    if (message.pendingDeliveryStatus === 'server_delivering') {
        return {
            kind: 'delivering',
            showSpinner: true,
            iconName: 'navigate-outline',
        };
    }

    const sessionRuntime = options?.sessionRuntime;
    const turnStartedAtMs = sessionRuntime?.turnStartedAtMs;
    const queuedWait = (reason: PendingMessageQueuedBehindTurnPresentation['reason']): PendingMessageVisualState => ({
        kind: 'queued_behind_turn',
        showSpinner: false,
        iconName: 'time-outline',
        queuedBehindTurn: {
            reason,
            ...(typeof turnStartedAtMs === 'number' && Number.isFinite(turnStartedAtMs) && turnStartedAtMs > 0
                ? { turnStartedAtMs }
                : {}),
        },
    });

    // Every action still needs an attached runtime. Keep this distinct from durable delivery
    // blocks: it is a queued admission reason and self-heals when runtime presence returns.
    if (sessionRuntime?.runtimeReachable === false) {
        return queuedWait('waiting_for_runtime');
    }

    // Waiting presentation follows the same action/foreground/timing facts as the claim owner.
    // Urgent actions never wait for broad runtime activity, and foreground-ready enqueue does not
    // inherit a background-activity wait unless the configured timing explicitly requires idle.
    const requestedAction = message.requestedAction?.kind ?? 'enqueue';
    const foregroundState = sessionRuntime?.foregroundState
        ?? (sessionRuntime?.isWorking === true ? 'active_unsteerable' : 'ready');
    const isExactAction = requestedAction === 'send_now'
        || requestedAction === 'steer_now'
        || (requestedAction === 'steer_if_active' && foregroundState === 'active_steerable');
    // One provider-custody claim is serialized at a time. Exact selection bypasses queued FIFO
    // neighbors, but never races a row whose provider effect may already be in flight.
    if (options?.hasProviderDeliveryInFlight === true) {
        return queuedWait('waiting_for_predecessor');
    }
    // Automatic delivery stays FIFO. A user-selected exact action targets that localId and leaves
    // ordinary predecessors queued instead of falsely presenting the selected row as blocked by
    // their order.
    if (options?.hasEarlierPendingPredecessor === true && !isExactAction) {
        return queuedWait('waiting_for_predecessor');
    }
    const ordinaryActionWaitsForForeground = requestedAction === 'enqueue'
        || (requestedAction === 'steer_if_active' && foregroundState !== 'active_steerable');
    const waitsForForeground = ordinaryActionWaitsForForeground && foregroundState !== 'ready';
    if (waitsForForeground) {
        return queuedWait('waiting_for_foreground_turn');
    }
    if (ordinaryActionWaitsForForeground && sessionRuntime?.deliveryTiming === 'after_runtime_idle') {
        const runtimeActivityState = sessionRuntime.runtimeActivityState ?? 'unknown';
        if (runtimeActivityState === 'active') {
            return queuedWait('waiting_for_runtime_activity');
        }
        if (runtimeActivityState === 'unknown') {
            return queuedWait('runtime_activity_unknown');
        }
    }

    return {
        kind: 'queued',
        showSpinner: false,
        iconName: 'time-outline',
    };
}
