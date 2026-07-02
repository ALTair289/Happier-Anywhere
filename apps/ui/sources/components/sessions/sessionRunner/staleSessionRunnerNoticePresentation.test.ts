import { describe, expect, it, vi } from 'vitest';

import type { ActionableStaleSessionRunnerStatus } from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatus';

import {
    buildStaleSessionRunnerNoticePresentation,
    type StaleSessionRunnerRestartViewStatus,
} from './staleSessionRunnerNoticePresentation';

const actionableStatus: ActionableStaleSessionRunnerStatus = {
    sessionId: 's1',
    machineId: 'machine-1',
    expectedRunnerPid: 123,
    expectedProcessCommandHash: 'hash-old',
    expectedRunnerEntrypointIdentity: 'version:cli-old',
    currentEntrypointIdentity: 'version:cli-new',
    disabledReason: null,
    fingerprint: 's1|machine-1|123|hash-old|version:cli-old|version:cli-new|eligible',
};

const translate = vi.fn((key: string) => key);

describe('staleSessionRunnerNoticePresentation', () => {
    it('builds the stale-runner banner and status badge descriptors', () => {
        const presentation = buildStaleSessionRunnerNoticePresentation({
            status: actionableStatus,
            operationStatus: null,
            translate,
        });

        expect(presentation).toEqual(expect.objectContaining({
            fingerprint: actionableStatus.fingerprint,
            banner: expect.objectContaining({
                testID: 'session-staleRunner-version',
                title: 'session.staleRunner.title',
                body: 'session.staleRunner.body',
                primaryAction: {
                    kind: 'restart',
                    label: 'session.staleRunner.restartAction',
                    accessibilityLabel: 'session.staleRunner.restartAction',
                    testID: 'session-staleRunner-version-restart',
                    disabled: false,
                },
            }),
            badge: {
                key: 'session-stale-runner',
                label: 'session.staleRunner.statusBadge',
                testID: 'session-staleRunner-status-badge',
                accessibilityLabel: 'session.staleRunner.statusBadge',
                tone: 'warning',
            },
        }));
    });

    it('disables the action and changes the action label while restart is pending', () => {
        const presentation = buildStaleSessionRunnerNoticePresentation({
            status: actionableStatus,
            operationStatus: { status: 'pending' },
            translate,
        });

        expect(presentation?.banner.primaryAction).toEqual(expect.objectContaining({
            label: 'session.staleRunner.restartPendingAction',
            disabled: true,
        }));
    });

    it('returns no presentation after success or already-current skip results', () => {
        for (const status of ['restarted', 'already_current'] satisfies ReadonlyArray<StaleSessionRunnerRestartViewStatus>) {
            expect(buildStaleSessionRunnerNoticePresentation({
                status: actionableStatus,
                operationStatus: { status },
                translate,
            })).toBeNull();
        }
    });

    it('surfaces retryable and terminal skip/error states without exact prose assertions', () => {
        expect(buildStaleSessionRunnerNoticePresentation({
            status: actionableStatus,
            operationStatus: { status: 'runner_identity_changed' },
            translate,
        })?.banner.body).toBe('session.staleRunner.identityChangedBody');

        expect(buildStaleSessionRunnerNoticePresentation({
            status: actionableStatus,
            operationStatus: { status: 'ineligible' },
            translate,
        })?.banner.primaryAction.disabled).toBe(true);

        expect(buildStaleSessionRunnerNoticePresentation({
            status: actionableStatus,
            operationStatus: { status: 'failed' },
            translate,
        })?.banner.body).toBe('session.staleRunner.failureBody');
    });
});
