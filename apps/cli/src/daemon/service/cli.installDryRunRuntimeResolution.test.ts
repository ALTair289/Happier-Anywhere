import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const {
    ensureJavaScriptRuntimeExecutableMock,
    resolveJavaScriptRuntimeExecutableMock,
    resolveDaemonServiceRuntimeTargetMock,
    planDaemonServiceInstallMock,
} = vi.hoisted(() => ({
    ensureJavaScriptRuntimeExecutableMock: vi.fn(async () => '/managed/node'),
    resolveJavaScriptRuntimeExecutableMock: vi.fn(() => null),
    resolveDaemonServiceRuntimeTargetMock: vi.fn(() => ({
        nodePath: '/managed/node',
        entryPath: '/opt/happier/package-dist/index.mjs',
    })),
    planDaemonServiceInstallMock: vi.fn(() => ({ files: [], commands: [] })),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
    ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('@/runtime/js/resolveJavaScriptRuntimeExecutable', () => ({
    resolveJavaScriptRuntimeExecutable: resolveJavaScriptRuntimeExecutableMock,
}));

vi.mock('./runtimeTarget', () => ({
    resolveDaemonServiceRuntimeTarget: resolveDaemonServiceRuntimeTargetMock,
}));

vi.mock('./plan', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./plan')>();
    return {
        ...actual,
        planDaemonServiceInstall: planDaemonServiceInstallMock,
    };
});

describe('runDaemonServiceCliCommand install dry-run runtime resolution', () => {
    const envKeys = [
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.doUnmock('./installer');
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('uses the managed node runtime when dry-run planning a service install', async () => {
        envScope.patch({
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/test',
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/test/.happier',
        });

        const output = captureStdoutJsonOutput<{ ok: boolean }>();
        try {
            const { runDaemonServiceCliCommand } = await import('./cli.js');

            await runDaemonServiceCliCommand({
                argv: ['install', '--dry-run', '--json'],
            });

            expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({
                isBunRuntime: false,
                currentExecPath: process.execPath,
                processEnv: process.env,
            });
            expect(resolveDaemonServiceRuntimeTargetMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeExecutable: '/managed/node',
                }),
            );
            expect(planDaemonServiceInstallMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    nodePath: '/managed/node',
                    entryPath: '/opt/happier/package-dist/index.mjs',
                }),
            );

            expect(output.json().ok).toBe(true);
        } finally {
            output.restore();
        }
    });

    it('preserves the resolved active server id when delegating direct pinned dry-run installs', async () => {
        envScope.patch({
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/test',
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/test/.happier',
            HAPPIER_ACTIVE_SERVER_ID: 'company-profile',
        });
        const previewDaemonServiceInstallMock = vi.fn(async () => ({
            exactTargetExists: false,
            exactTargetIsConverged: false,
            exactTargetMatchesExpectedDefinition: false,
            strategy: 'require-explicit',
            conflictPlan: {
                exactTargetExists: false,
                exactTargetIsConverged: false,
                competingServices: [],
                foreignHomeConflicts: [],
                servicesToRemove: [],
            },
            plan: { files: [], commands: [] },
        }));
        vi.doMock('./installer', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./installer')>();
            return {
                ...actual,
                previewDaemonServiceInstall: previewDaemonServiceInstallMock,
            };
        });

        const output = captureStdoutJsonOutput<{ ok: boolean }>();
        try {
            const { runDaemonServiceCliCommand } = await import('./cli.js');

            await runDaemonServiceCliCommand({
                argv: ['install', '--instance', 'service-instance', '--dry-run', '--json'],
            });

            expect(previewDaemonServiceInstallMock).toHaveBeenCalledWith(expect.objectContaining({
                targetMode: 'pinned',
                instanceId: 'service-instance',
                activeServerId: 'company-profile',
            }));

            expect(output.json().ok).toBe(true);
        } finally {
            output.restore();
        }
    });
});
