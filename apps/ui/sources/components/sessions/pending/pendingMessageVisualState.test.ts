import { describe, expect, it } from 'vitest';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import { getPendingMessageVisualState } from './pendingMessageVisualState';

function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'p1',
        createdAt: 0,
        updatedAt: 0,
        source: 'server_pending',
        text: 'hello',
        rawRecord: {},
        ...overrides,
    };
}

describe('getPendingMessageVisualState', () => {
    it('treats server accepted rows as queued, not actively processing', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'server_pending',
            deliveryStatus: 'accepted',
        }))).toEqual({
            kind: 'queued',
            showSpinner: false,
            iconName: 'time-outline',
        });
    });

    it('shows saving only for local outbound rows that are not yet accepted', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
        }))).toEqual({
            kind: 'saving',
            showSpinner: true,
            iconName: 'cloud-upload-outline',
        });
    });

    it('shows persisted quarantine as terminal blocked custody rather than saving', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'unknown',
        }))).toMatchObject({ kind: 'blocked', showSpinner: false });
    });

    it('allows the caller to mark the single row currently materializing', () => {
        expect(getPendingMessageVisualState(pendingMessage({ id: 'p2', localId: 'p2' }), {
            materializingLocalIds: new Set(['p2']),
        })).toEqual({
            kind: 'materializing',
            showSpinner: true,
            iconName: 'navigate-outline',
        });
    });

    it('treats server-delivering rows as delivery-owned work', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'server_delivering',
        }))).toEqual({
            kind: 'delivering',
            showSpinner: true,
            iconName: 'navigate-outline',
        });
    });

    it('surfaces an unconfirmed send while automatic retries are still in flight', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'unconfirmed',
        }))).toEqual({
            kind: 'send_unconfirmed',
            showSpinner: true,
            iconName: 'cloud-upload-outline',
        });
    });

    it('surfaces a failed send with no spinner once retries give up', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'failed',
        }))).toEqual({
            kind: 'send_failed',
            showSpinner: false,
            iconName: 'alert-circle-outline',
        });
    });

    it('keeps cancellation distinct from send retry state', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxOperation: 'cancel',
        }))).toMatchObject({ kind: 'cancelling', showSpinner: true });
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxOperation: 'cancel',
            sendState: 'failed',
        }))).toMatchObject({ kind: 'cancel_failed', showSpinner: false });
    });

    it('keeps failed-send precedence over the in-flight saving state', () => {
        // A row that never got acknowledged is still local_outbound/queued, but the failed marker
        // must win so the user sees a retry affordance instead of a perpetual spinner.
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'failed',
        })).kind).toBe('send_failed');
    });

    it.each([
        ['server_queued', undefined, 'queued'],
        ['server_delivering', undefined, 'delivering'],
        ['blocked', 'ambiguous_terminal_delivery', 'delivery_uncertain'],
        ['blocked', 'delivery_outcome_uncertain', 'delivery_uncertain'],
        ['blocked', 'provider_rejected_before_acceptance', 'blocked'],
    ] as const)(
        'lets retained durable state %s/%s outrank a stale local send failure',
        (pendingDeliveryStatus, pendingDeliveryBlockedReason, expectedKind) => {
            expect(getPendingMessageVisualState(pendingMessage({
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                sendState: 'failed',
                pendingDeliveryStatus,
                ...(pendingDeliveryBlockedReason ? { pendingDeliveryBlockedReason } : {}),
            })).kind).toBe(expectedKind);
        },
    );

    it('treats the retired timeout reason as unknown while preserving current uncertainty', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_acceptance_timeout' as never,
            pendingDeliveryBlockedReasonRaw: 'provider_acceptance_timeout',
        }))).toMatchObject({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'alert-circle-outline',
            deliveryBlockedPresentation: { isUnknown: true },
        });
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'ambiguous_terminal_delivery',
        }))).toMatchObject({
            kind: 'delivery_uncertain',
            showSpinner: false,
            iconName: 'alert-circle-outline',
        });
    });

    it('keeps retained external handoffs visible without implying active provider delivery', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
        }))).toEqual({
            kind: 'delivering',
            showSpinner: false,
            iconName: 'navigate-outline',
        });
    });

    it('derives queued_behind_turn only while the session is actively working', () => {
        const message = pendingMessage({ source: 'server_pending', deliveryStatus: 'accepted' });
        expect(getPendingMessageVisualState(message, {
            sessionRuntime: { isWorking: true, turnStartedAtMs: 1000 },
        })).toEqual({
            kind: 'queued_behind_turn',
            showSpinner: false,
            iconName: 'time-outline',
            queuedBehindTurn: { reason: 'waiting_for_foreground_turn', turnStartedAtMs: 1000 },
        });

        // Idle session => plain queued (unchanged shape).
        expect(getPendingMessageVisualState(message, {
            sessionRuntime: { isWorking: false },
        })).toEqual({
            kind: 'queued',
            showSpinner: false,
            iconName: 'time-outline',
        });
    });

    it('does not turn an absent epoch timestamp into a multi-year running duration', () => {
        const message = pendingMessage({ source: 'server_pending', deliveryStatus: 'accepted' });

        expect(getPendingMessageVisualState(message, {
            sessionRuntime: { isWorking: true, turnStartedAtMs: 0 },
        })).toEqual({
            kind: 'queued_behind_turn',
            showSpinner: false,
            iconName: 'time-outline',
            queuedBehindTurn: { reason: 'waiting_for_foreground_turn' },
        });
    });

    it('does not label urgent or foreground-ready actions as waiting behind background work', () => {
        const activeRuntime = {
            isWorking: true,
            foregroundState: 'active_unsteerable' as const,
            deliveryTiming: 'after_foreground_ready' as const,
        };
        for (const kind of ['send_now', 'steer_now'] as const) {
            expect(getPendingMessageVisualState(pendingMessage({
                requestedAction: { v: 1, kind },
            }), { sessionRuntime: activeRuntime }).kind).toBe('queued');
        }

        expect(getPendingMessageVisualState(pendingMessage({
            requestedAction: { v: 1, kind: 'enqueue' },
        }), {
            sessionRuntime: {
                isWorking: true,
                foregroundState: 'ready',
                deliveryTiming: 'after_foreground_ready',
            },
        }).kind).toBe('queued');

        expect(getPendingMessageVisualState(pendingMessage({
            requestedAction: { v: 1, kind: 'enqueue' },
        }), {
            sessionRuntime: {
                isWorking: true,
                foregroundState: 'ready',
                deliveryTiming: 'after_runtime_idle',
            },
        }).kind).toBe('queued_behind_turn');
    });

    it.each([
        'send_now',
        'steer_now',
        'steer_if_active',
    ] as const)('lets exact urgent %s semantics outrank an earlier ordinary FIFO predecessor', (kind) => {
        expect(getPendingMessageVisualState(pendingMessage({
            requestedAction: { v: 1, kind },
        }), {
            hasEarlierPendingPredecessor: true,
            sessionRuntime: {
                isWorking: true,
                runtimeReachable: true,
                runtimeActivityState: 'active',
                foregroundState: 'active_steerable',
                deliveryTiming: 'after_runtime_idle',
            },
        })).toMatchObject({
            kind: 'queued',
        });
        expect(getPendingMessageVisualState(pendingMessage({
            requestedAction: { v: 1, kind },
        }), {
            hasEarlierPendingPredecessor: true,
            sessionRuntime: {
                isWorking: true,
                runtimeReachable: true,
                runtimeActivityState: 'active',
                foregroundState: 'active_steerable',
                deliveryTiming: 'after_runtime_idle',
            },
        })).not.toHaveProperty('queuedBehindTurn');
    });

    it('keeps an exact urgent action serialized behind an earlier provider-custody claim', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            requestedAction: { v: 1, kind: 'send_now' },
        }), {
            hasEarlierPendingPredecessor: true,
            hasProviderDeliveryInFlight: true,
            sessionRuntime: {
                isWorking: true,
                runtimeReachable: true,
                foregroundState: 'active_unsteerable',
                deliveryTiming: 'after_foreground_ready',
            },
        })).toMatchObject({
            kind: 'queued_behind_turn',
            queuedBehindTurn: { reason: 'waiting_for_predecessor' },
        });
    });

    it('projects runtime reachability before action and timing admission', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            requestedAction: { v: 1, kind: 'send_now' },
        }), {
            sessionRuntime: {
                isWorking: false,
                runtimeReachable: false,
                runtimeActivityState: 'unknown',
                foregroundState: 'ready',
                deliveryTiming: 'after_foreground_ready',
            },
        })).toMatchObject({
            kind: 'queued_behind_turn',
            queuedBehindTurn: { reason: 'waiting_for_runtime' },
        });
    });

    it.each([
        ['active', 'waiting_for_runtime_activity'],
        ['unknown', 'runtime_activity_unknown'],
    ] as const)('projects canonical %s Activity for an ordinary runtime-idle row', (runtimeActivityState, reason) => {
        expect(getPendingMessageVisualState(pendingMessage(), {
            sessionRuntime: {
                isWorking: runtimeActivityState === 'active',
                runtimeReachable: true,
                runtimeActivityState,
                foregroundState: 'ready',
                deliveryTiming: 'after_runtime_idle',
            },
        })).toMatchObject({
            kind: 'queued_behind_turn',
            queuedBehindTurn: { reason },
        });
    });

    it('admits an ordinary runtime-idle row only from canonical idle Activity', () => {
        expect(getPendingMessageVisualState(pendingMessage(), {
            sessionRuntime: {
                isWorking: false,
                runtimeReachable: true,
                runtimeActivityState: 'idle',
                foregroundState: 'ready',
                deliveryTiming: 'after_runtime_idle',
            },
        }).kind).toBe('queued');
    });

    it('does not promote failed/unconfirmed rows to queued_behind_turn', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'failed',
        }), { sessionRuntime: { isWorking: true, turnStartedAtMs: 5 } }).kind).toBe('send_failed');
    });

    it('attaches reason-specific presentation to blocked delivery rows', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'payload_too_large',
        }))).toEqual({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'alert-circle-outline',
            deliveryBlockedReason: 'payload_too_large',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.payloadTooLarge',
                isUnknown: false,
            },
        });

        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        }))).toEqual({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'alert-circle-outline',
            deliveryBlockedReason: 'provider_unavailable_before_acceptance',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.providerUnavailableBeforeAcceptance',
                isUnknown: false,
            },
        });

        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'runtime_config_blocked',
        }))).toEqual({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'alert-circle-outline',
            deliveryBlockedReason: 'runtime_config_blocked',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked',
                isUnknown: false,
            },
        });

        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'unknown',
            pendingDeliveryBlockedReasonRaw: 'newer_runtime_reason',
        }))).toEqual({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'alert-circle-outline',
            deliveryBlockedReason: 'unknown',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.unknown',
                isUnknown: true,
            },
        });
    });
});
