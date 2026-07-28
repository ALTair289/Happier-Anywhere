import { describe, expect, it } from 'vitest';

import {
    readActionableStaleSessionRunnerStatus,
    SESSION_RUNNER_RUNTIME_STATE_FIELD_ID,
} from './sessionRunnerRuntimeStatus';

function staleRuntimeState(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        sessionId: 's1',
        machineId: 'machine-1',
        observedAtMs: 1,
        runner: {
            pid: 123,
            runtimeId: 'version:cli-old',
            processCommandHash: 'hash-old',
            entrypointVersion: 'cli-old',
            entrypointSource: 'process_command',
            startedBy: 'daemon',
            startingMode: 'remote',
        },
        daemon: {
            currentEntrypointVersion: 'version:cli-new',
            currentEntrypointSource: 'launch_spec',
        },
        versionState: 'stale',
        statusSource: 'daemon_tracking',
        plannedRestart: {
            supported: true,
            eligible: true,
        },
        ...overrides,
    };
}

describe('sessionRunnerRuntimeStatus', () => {
    it('returns an actionable stale status from canonical daemon runtime state', () => {
        const status = readActionableStaleSessionRunnerStatus({
            sessionId: 's1',
            machineId: 'machine-1',
            metadata: {
                [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState(),
            },
        });

        expect(status).toEqual({
            sessionId: 's1',
            machineId: 'machine-1',
            expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old',
            expectedRunnerEntrypointIdentity: 'version:cli-old',
            currentEntrypointIdentity: 'version:cli-new',
            disabledReason: null,
            fingerprint: 's1|machine-1|123|hash-old|version:cli-old|version:cli-new|eligible',
        });
    });

    it('keeps an exact daemon-owned stale runner actionable after the server session becomes inactive', () => {
        const status = readActionableStaleSessionRunnerStatus({
            sessionId: 's1',
            machineId: 'machine-1',
            metadata: {
                [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState(),
            },
        });

        expect(status).toMatchObject({
            sessionId: 's1',
            machineId: 'machine-1',
            expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old',
        });
    });

    it('fails closed when daemon status is missing, malformed, current, unsupported, or ineligible', () => {
        const cases: ReadonlyArray<Readonly<{
            name: string;
            machineId?: string | null;
            metadata: unknown;
        }>> = [
            { name: 'missing status', metadata: {} },
            { name: 'malformed status', metadata: { [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: { v: 1 } } },
            { name: 'current status', metadata: { [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({ versionState: 'current' }) } },
            { name: 'missing machine target', machineId: null, metadata: { [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState() } },
            { name: 'missing daemon machine identity', metadata: { [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({ machineId: null }) } },
            {
                name: 'unsupported restart',
                metadata: {
                    [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({
                        plannedRestart: {
                            supported: false,
                            eligible: false,
                            disabledReason: 'unsupported_daemon_version',
                        },
                    }),
                },
            },
            {
                name: 'ineligible restart',
                metadata: {
                    [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({
                        plannedRestart: { supported: true, eligible: false, disabledReason: 'turn_in_progress' },
                    }),
                },
            },
            {
                name: 'missing comparable runner identity',
                metadata: {
                    [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({
                        runner: {
                            pid: 123,
                            runtimeId: null,
                            processCommandHash: 'hash-old',
                            entrypointVersion: 'cli-old',
                            entrypointSource: 'process_command',
                            startedBy: 'daemon',
                            startingMode: 'remote',
                        },
                    }),
                },
            },
            {
                name: 'missing runner version identity',
                metadata: {
                    [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({
                        runner: {
                            pid: 123,
                            runtimeId: null,
                            processCommandHash: 'hash-old',
                            entrypointSource: 'process_command',
                            startedBy: 'daemon',
                            startingMode: 'remote',
                        },
                    }),
                },
            },
            {
                name: 'missing current identity',
                metadata: {
                    [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({
                        daemon: {},
                    }),
                },
            },
        ];

        for (const testCase of cases) {
            expect(
                readActionableStaleSessionRunnerStatus({
                    sessionId: 's1',
                    machineId: testCase.machineId === undefined ? 'machine-1' : testCase.machineId,
                    metadata: testCase.metadata,
                }),
                testCase.name,
            ).toBeNull();
        }
    });

    it('rejects stale status for a different session or machine identity', () => {
        expect(readActionableStaleSessionRunnerStatus({
            sessionId: 's1',
            machineId: 'machine-1',
            metadata: {
                [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({ sessionId: 's2' }),
            },
        })).toBeNull();

        expect(readActionableStaleSessionRunnerStatus({
            sessionId: 's1',
            machineId: 'machine-1',
            metadata: {
                [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: staleRuntimeState({ machineId: 'machine-2' }),
            },
        })).toBeNull();
    });
});
