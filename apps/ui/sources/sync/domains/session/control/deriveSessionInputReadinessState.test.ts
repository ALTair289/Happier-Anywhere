import { describe, expect, it } from 'vitest';

import { deriveSessionInputReadinessState } from './deriveSessionInputReadinessState';

describe('deriveSessionInputReadinessState', () => {
    const nowMs = 1_000_000;

    it('accepts the next turn when foreground and serviceability facts are ready', () => {
        const input = {
            active: true,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: nowMs - 1,
            get runtimeActivityState(): never {
                throw new Error('input readiness must not read Activity presentation fields');
            },
            get runtimeActivitySourceClass(): never {
                throw new Error('input readiness must not read Activity presentation fields');
            },
        };

        expect(deriveSessionInputReadinessState(input, nowMs)).toEqual({
            disposition: 'accepts_next_turn',
            isInputBusy: false,
            canWakePendingQueue: true,
        });
    });

    it('treats a fresh foreground turn as input-busy and exposes steer only by capability', () => {
        const input = {
            active: true,
            activeAt: nowMs - 1,
            presence: 'online',
            latestTurnStatus: 'in_progress' as const,
            latestTurnStatusObservedAt: nowMs - 1,
        };

        expect(deriveSessionInputReadinessState(input, nowMs)).toMatchObject({
            disposition: 'blocked',
            isInputBusy: true,
        });
        expect(deriveSessionInputReadinessState({
            ...input,
            inFlightSteerSupported: true,
            inFlightSteerAvailable: true,
        }, nowMs)).toMatchObject({
            disposition: 'steer_available',
            isInputBusy: true,
        });
    });
});
