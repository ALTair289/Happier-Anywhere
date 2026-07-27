import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const resumeCapabilityOptionsSpy = vi.hoisted(() =>
    vi.fn<(args: unknown) => { resumeCapabilityOptions: Record<string, never> }>(() => ({ resumeCapabilityOptions: {} })));
const executionRunsBackendsSpy = vi.hoisted(() =>
    vi.fn<(sessionId: string) => { claude: { available: true; intents: ['review'] } }>(
        () => ({ claude: { available: true, intents: ['review'] } }),
    ));
const sessionMachineTargetState = vi.hoisted(() => ({
    value: null as null | { machineId: string; basePath: string },
}));

vi.mock('@/sync/domains/state/storage', () => createStorageModuleStub({
    useSettings: () => ({}),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: (sessionId: string) => executionRunsBackendsSpy(sessionId),
}));

vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => true,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => sessionMachineTargetState.value,
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: () => ({
        directSessionLink: null,
        status: { runnerActive: true },
    }),
}));

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: (args: unknown) => resumeCapabilityOptionsSpy(args),
}));

vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canResumeSessionWithOptions: () => true,
}));

describe('useSessionExecutionRunLaunchability', () => {
    afterEach(() => {
        standardCleanup();
        resumeCapabilityOptionsSpy.mockClear();
        executionRunsBackendsSpy.mockClear();
        sessionMachineTargetState.value = null;
    });

    it('builds resume capability options from the resolved session machine target', async () => {
        sessionMachineTargetState.value = { machineId: 'machine-reachable', basePath: '/tmp/reachable' };
        const session = {
            id: 'session-1',
            active: false,
            metadata: {
                flavor: 'claude',
                machineId: 'machine-stale',
                path: '/tmp/stale',
            },
        } as any;

        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('session-1', session));

        expect(resumeCapabilityOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-reachable',
            enabled: true,
        }));
        expect(hook.getCurrent().canShowExecutionRunLauncher).toBe(true);

        await hook.unmount();
    });

    it('does not offer an execution-run launch while an inactive session is already resuming', async () => {
        const session = createSessionFixture({
            id: 'session-1',
            active: false,
            resumingAt: Date.now(),
            metadata: {
                flavor: 'claude',
                host: 'machine-reachable',
                machineId: 'machine-reachable',
                path: '/tmp/reachable',
            },
        });

        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('session-1', session));

        expect(hook.getCurrent().canShowExecutionRunLauncher).toBe(false);
        expect(hook.getCurrent().canLaunchExecutionRuns).toBe(false);

        await hook.unmount();
    });
});
