import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('readDaemonState', () => {
    const envKeys = [
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);

    beforeEach(() => {
        envScope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
    });

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
    });

    it('retries when the daemon state file appears shortly after the call starts', async () => {
        await withTempDir('happier-cli-daemon-state-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            setTimeout(() => {
                mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
                writeFileSync(
                    configuration.daemonStateFile,
                    JSON.stringify(
                        {
                            pid: 123,
                            httpPort: 5173,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.0.0-test',
                            controlToken: 'token-123',
                        },
                        null,
                        2
                    ),
                    'utf-8'
                );
            }, 5);

            const state = await readDaemonState();
            expect(state?.pid).toBe(123);
        });
    });

    it('scopes the daemon state file name by public release channel so lanes do not collide', async () => {
        await withTempDir('happier-cli-daemon-state-scope-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: undefined,
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }] = await Promise.all([import('./configuration')]);

            expect(configuration.daemonStateFile).toBe(join(configuration.activeServerDir, 'daemon.state.json'));
        });
    });

    it('reads but does not promote a legacy owner from another process', async () => {
        await withTempDir('happier-cli-daemon-state-legacy-ring-fallback-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            const legacyPath = join(configuration.activeServerDir, 'daemon.dev.state.json');
            mkdirSync(dirname(legacyPath), { recursive: true });
            writeFileSync(
                legacyPath,
                JSON.stringify(
                    {
                        pid: 321,
                        httpPort: 5173,
                        startedAt: Date.now(),
                        startedWithCliVersion: '0.0.0-test',
                        controlToken: 'legacy-token-321',
                    },
                    null,
                    2,
                ),
                'utf-8',
            );
            writeFileSync(configuration.daemonLockFile, '321', 'utf8');

            const state = await readDaemonState();
            expect(state?.pid).toBe(321);
            expect(existsSync(configuration.daemonStateFile)).toBe(false);
        });
    });

    it('promotes legacy state only when the current process owns the lifecycle lock', async () => {
        await withTempDir('happier-cli-daemon-state-owned-legacy-promotion-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);
            const legacyPath = join(configuration.activeServerDir, 'daemon.dev.state.json');
            mkdirSync(dirname(legacyPath), { recursive: true });
            writeFileSync(legacyPath, JSON.stringify({
                pid: process.pid,
                httpPort: 5173,
                startedAt: 1_000,
                startedWithCliVersion: '0.0.0-test',
                controlToken: 'current-process-token',
            }, null, 2), 'utf8');
            writeFileSync(configuration.daemonLockFile, String(process.pid), 'utf8');

            await expect(readDaemonState()).resolves.toMatchObject({ pid: process.pid });
            expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8'))).toMatchObject({
                pid: process.pid,
                controlToken: 'current-process-token',
            });
        });
    });

    it('preserves runtime ownership metadata when reading the canonical daemon state file', async () => {
        await withTempDir('happier-cli-daemon-state-runtime-metadata-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
            writeFileSync(
                configuration.daemonStateFile,
                JSON.stringify(
                    {
                        pid: 654,
                        httpPort: 5173,
                        startedAt: Date.now(),
                        startedWithCliVersion: '0.0.0-test',
                        startedWithPublicReleaseChannel: 'preview',
                        runtimeId: 'runtime-654',
                        startupSource: 'background-service',
                        serviceLabel: 'com.happier.cli.daemon.default',
                        controlToken: 'ownership-token-654',
                    },
                    null,
                    2,
                ),
                'utf-8',
            );

            const state = await readDaemonState();
            expect(state?.runtimeId).toBe('runtime-654');
            expect(state?.startupSource).toBe('background-service');
            expect(state?.serviceLabel).toBe('com.happier.cli.daemon.default');
            expect(state?.startedWithPublicReleaseChannel).toBe('preview');
        });
    });

    it('reads only the explicit daemon lifecycle scope when the endpoint profile differs', async () => {
        await withTempDir('happier-cli-daemon-state-explicit-lifecycle-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
            });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);
            const exactState = {
                pid: 741,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-current',
            };
            const endpointDecoy = {
                ...exactState,
                pid: 742,
                startedWithCliVersion: '0.0.0-endpoint-decoy',
            };
            mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
            writeFileSync(configuration.daemonStateFile, JSON.stringify(exactState), 'utf-8');
            mkdirSync(configuration.activeServerDir, { recursive: true });
            writeFileSync(join(configuration.activeServerDir, 'daemon.state.json'), JSON.stringify(endpointDecoy), 'utf-8');

            expect(configuration.daemonStateFile).not.toBe(join(configuration.activeServerDir, 'daemon.state.json'));
            await expect(readDaemonState()).resolves.toMatchObject({ pid: 741 });
        });
    });

    it('does not scan matching settings profiles when an explicit daemon lifecycle scope is missing state', async () => {
        await withTempDir('happier-cli-daemon-state-explicit-no-profile-scan-', async (homeDir) => {
            const livePid = 743;
            const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
                if (signal === 0 && pid === livePid) return true;
                const error = new Error('ESRCH') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }) as typeof process.kill);
            try {
                writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
                    schemaVersion: 6,
                    activeServerId: 'endpoint-profile',
                    servers: {
                        'endpoint-profile': {
                            id: 'endpoint-profile',
                            serverUrl: 'http://127.0.0.1:53288',
                            webappUrl: 'http://127.0.0.1:53288',
                        },
                        'matching-profile-alias': {
                            id: 'matching-profile-alias',
                            serverUrl: 'http://127.0.0.1:53288',
                            webappUrl: 'http://127.0.0.1:53288',
                        },
                    },
                }), 'utf-8');
                vi.resetModules();
                envScope.patch({
                    HAPPIER_HOME_DIR: homeDir,
                    HAPPIER_ACTIVE_SERVER_ID: 'endpoint-profile',
                    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                    HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
                    HAPPIER_WEBAPP_URL: 'http://127.0.0.1:53288',
                });

                const { readDaemonState } = await import('./persistence');
                const decoyPath = join(homeDir, 'servers', 'matching-profile-alias', 'daemon.state.json');
                mkdirSync(dirname(decoyPath), { recursive: true });
                writeFileSync(decoyPath, JSON.stringify({
                    pid: livePid,
                    httpPort: 5173,
                    startedAt: Date.now(),
                    startedWithCliVersion: '0.0.0-decoy',
                }), 'utf-8');

                await expect(readDaemonState()).resolves.toBeNull();
            } finally {
                killSpy.mockRestore();
            }
        });
    });

    it('falls back to a daemon state file under another server dir only when it matches the active server selection', async () => {
        await withTempDir('happier-cli-daemon-state-fallback-', async (homeDir) => {
            const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
                if (signal === 0 && pid === 456) return true;
                const error = new Error('ESRCH') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }) as typeof process.kill);

            try {
                writeFileSync(
                    join(homeDir, 'settings.json'),
                    JSON.stringify(
                        {
                            schemaVersion: 6,
                            onboardingCompleted: false,
                            activeServerId: 'localhost-53288',
                            servers: {
                                'localhost-53288': {
                                    id: 'localhost-53288',
                                    name: 'Current',
                                    serverUrl: 'http://127.0.0.1:53288',
                                    webappUrl: 'http://127.0.0.1:53288',
                                    createdAt: 0,
                                    updatedAt: 0,
                                    lastUsedAt: 0,
                                },
                                'stack_test__id_default': {
                                    id: 'stack_test__id_default',
                                    name: 'Legacy alias',
                                    serverUrl: 'http://127.0.0.1:53288',
                                    webappUrl: 'http://127.0.0.1:53288',
                                    createdAt: 0,
                                    updatedAt: 0,
                                    lastUsedAt: 0,
                                },
                            },
                        },
                        null,
                        2,
                    ),
                    'utf-8',
                );

                vi.resetModules();
                envScope.patch({
                    HAPPIER_HOME_DIR: homeDir,
                    HAPPIER_ACTIVE_SERVER_ID: 'localhost-53288',
                    HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
                    HAPPIER_WEBAPP_URL: 'http://127.0.0.1:53288',
                });

                const [{ configuration }, { readDaemonState }] = await Promise.all([
                    import('./configuration'),
                    import('./persistence'),
                ]);

                // Write a daemon state file under a different server id to simulate stack-managed daemon ids.
                const fallbackPath = join(homeDir, 'servers', 'stack_test__id_default', 'daemon.state.json');
                mkdirSync(dirname(fallbackPath), { recursive: true });
                writeFileSync(
                    fallbackPath,
                    JSON.stringify(
                        {
                            pid: 456,
                            httpPort: 5173,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.0.0-test',
                            controlToken: 'token-456',
                        },
                        null,
                        2
                    ),
                    'utf-8'
                );

                // Sanity: active daemon state path should be different (and missing).
                expect(configuration.daemonStateFile).not.toBe(fallbackPath);

                const state = await readDaemonState();
                expect(state?.pid).toBe(456);

                rmSync(dirname(fallbackPath), { recursive: true, force: true });
                const stalePath = join(homeDir, 'servers', 'stack_test__id_stale', 'daemon.state.json');
                mkdirSync(dirname(stalePath), { recursive: true });
                writeFileSync(
                    stalePath,
                    JSON.stringify(
                        {
                            pid: 999_999,
                            httpPort: 5173,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.0.0-test',
                            controlToken: 'token-stale',
                        },
                        null,
                        2
                    ),
                    'utf-8'
                );

                const staleState = await readDaemonState();
                expect(staleState).toBeNull();
            } finally {
                killSpy.mockRestore();
            }
        });
    });

    it('does not fall back to a live daemon state file from a different configured server', async () => {
        await withTempDir('happier-cli-daemon-state-cross-server-', async (homeDir) => {
            const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
                if (signal === 0 && pid === 654) return true;
                const error = new Error('ESRCH') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }) as typeof process.kill);

            try {
                writeFileSync(
                    join(homeDir, 'settings.json'),
                    JSON.stringify(
                        {
                            schemaVersion: 6,
                            onboardingCompleted: false,
                            activeServerId: '127.0.0.1-3005',
                            servers: {
                                '127.0.0.1-3005': {
                                    id: '127.0.0.1-3005',
                                    name: 'Current',
                                    serverUrl: 'http://127.0.0.1:3005',
                                    webappUrl: 'http://127.0.0.1:3005',
                                    createdAt: 0,
                                    updatedAt: 0,
                                    lastUsedAt: 0,
                                },
                                '127.0.0.1-4325': {
                                    id: '127.0.0.1-4325',
                                    name: 'Other',
                                    serverUrl: 'http://127.0.0.1:4325',
                                    webappUrl: 'http://127.0.0.1:4325',
                                    createdAt: 0,
                                    updatedAt: 0,
                                    lastUsedAt: 0,
                                },
                            },
                        },
                        null,
                        2,
                    ),
                    'utf-8',
                );

                vi.resetModules();
                envScope.patch({
                    HAPPIER_HOME_DIR: homeDir,
                    HAPPIER_ACTIVE_SERVER_ID: '127.0.0.1-3005',
                    HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
                    HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3005',
                });

                const [{ readDaemonState }] = await Promise.all([
                    import('./persistence'),
                ]);

                const fallbackPath = join(homeDir, 'servers', '127.0.0.1-4325', 'daemon.state.json');
                mkdirSync(dirname(fallbackPath), { recursive: true });
                writeFileSync(
                    fallbackPath,
                    JSON.stringify(
                        {
                            pid: 654,
                            httpPort: 5173,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.0.0-test',
                            controlToken: 'token-654',
                        },
                        null,
                        2,
                    ),
                    'utf-8',
                );

                await expect(readDaemonState()).resolves.toBeNull();
            } finally {
                killSpy.mockRestore();
            }
        });
    });

    it('accepts legacy startTime fields and normalizes to startedAt', async () => {
        await withTempDir('happier-cli-daemon-state-legacy-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            const legacyStarted = new Date().toISOString();
            writeFileSync(
                configuration.daemonStateFile,
                JSON.stringify(
                    {
                        pid: 123,
                        httpPort: 5173,
                        startTime: legacyStarted,
                        startedWithCliVersion: '0.0.0-test',
                    },
                    null,
                    2
                ),
                'utf-8'
            );

            const state = await readDaemonState();
            expect(state?.pid).toBe(123);
            expect(typeof state?.startedAt).toBe('number');
        });
    });
});

describe('daemon state canonicalization', () => {
    const envKeys = [
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);

    beforeEach(() => {
        envScope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
    });

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
    });

    it('removes legacy ring-scoped daemon state files after writing the canonical owner state', async () => {
        await withTempDir('happier-cli-daemon-state-write-canonical-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }, { writeDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            const legacyPath = join(configuration.activeServerDir, 'daemon.dev.state.json');
            mkdirSync(dirname(legacyPath), { recursive: true });
            writeFileSync(
                legacyPath,
                JSON.stringify({
                    pid: 999,
                    httpPort: 5173,
                    startedAt: Date.now(),
                    startedWithCliVersion: '0.0.0-old',
                }),
                'utf-8',
            );

            writeDaemonState({
                pid: 123,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-new',
                runtimeId: 'runtime-123',
            });

            expect(existsSync(configuration.daemonStateFile)).toBe(true);
            expect(existsSync(legacyPath)).toBe(false);
        });
    });

    it('cleans legacy ring state only inside the explicit lifecycle directory', async () => {
        await withTempDir('happier-cli-daemon-state-lifecycle-cleanup-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }, { writeDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);
            const lifecycleLegacyPath = join(dirname(configuration.daemonStateFile), 'daemon.dev.state.json');
            const endpointLegacyPath = join(configuration.activeServerDir, 'daemon.dev.state.json');
            mkdirSync(dirname(lifecycleLegacyPath), { recursive: true });
            mkdirSync(dirname(endpointLegacyPath), { recursive: true });
            writeFileSync(lifecycleLegacyPath, '{}', 'utf-8');
            writeFileSync(endpointLegacyPath, '{}', 'utf-8');

            writeDaemonState({
                pid: 744,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-current',
            });

            expect(existsSync(configuration.daemonStateFile)).toBe(true);
            expect(existsSync(lifecycleLegacyPath)).toBe(false);
            expect(existsSync(endpointLegacyPath)).toBe(true);
        });
    });

    it('uses a unique temp file per daemon state write to avoid cross-write corruption during restarts', async () => {
        await withTempDir('happier-cli-daemon-state-unique-tmp-', async (homeDir) => {
            const writeFileSyncSpy = vi.fn();

            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });

            vi.doMock('node:fs', async (importOriginal) => {
                const actual = await importOriginal<typeof import('node:fs')>();
                return {
                    ...actual,
                    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
                        writeFileSyncSpy(...args);
                        return actual.writeFileSync(...args);
                    },
                };
            });

            const [{ configuration }, { writeDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            writeDaemonState({
                pid: 123,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-a',
            });

            writeDaemonState({
                pid: 123,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-b',
                lastHeartbeatAt: Date.now(),
            });

            const tempWrites = writeFileSyncSpy.mock.calls
                .map((call) => call[0])
                .filter((value): value is string => typeof value === 'string' && value.startsWith(`${configuration.daemonStateFile}.tmp`));

            expect(tempWrites.length).toBeGreaterThanOrEqual(2);
            expect(tempWrites[tempWrites.length - 1]).not.toBe(tempWrites[tempWrites.length - 2]);
        });
    });

    it('publishes daemon state only while the current process owns the lifecycle lock', async () => {
        await withTempDir('happier-cli-daemon-state-lock-owned-write-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
            });

            const [{ configuration }, {
                writeDaemonStateIfLockOwned,
                writeDaemonState,
            }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);
            const currentState = {
                pid: process.pid,
                httpPort: 5173,
                startedAt: 1_000,
                startedWithCliVersion: '0.0.0-current',
                runtimeId: 'runtime-current',
            };
            writeDaemonState(currentState);
            writeFileSync(configuration.daemonLockFile, String(process.pid), 'utf8');

            expect(writeDaemonStateIfLockOwned({
                ...currentState,
                machineId: 'machine-current',
                lastHeartbeatAt: 2_000,
            })).toBe(true);
            expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8'))).toMatchObject({
                pid: process.pid,
                machineId: 'machine-current',
                lastHeartbeatAt: 2_000,
            });

            const successorState = {
                pid: process.pid + 1,
                httpPort: 6173,
                startedAt: 3_000,
                startedWithCliVersion: '0.0.0-current',
                runtimeId: 'runtime-successor',
            };
            writeDaemonState(successorState);
            writeFileSync(configuration.daemonLockFile, String(process.pid + 1), 'utf8');

            expect(writeDaemonStateIfLockOwned({
                ...currentState,
                lastHeartbeatAt: 4_000,
            })).toBe(false);
            expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8'))).toEqual(successorState);
        });
    });

    it('publishes and clears a lifecycle-scoped minimal connected-service broker descriptor', async () => {
        await withTempDir('happier-cli-broker-state-lifecycle-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
            });

            const [{ configuration }, {
                clearDaemonStateForTests,
                writeConnectedServiceBrokerState,
                writeDaemonState,
            }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            writeDaemonState({
                pid: 123,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-current',
                controlToken: 'broad-control-token',
            });
            writeConnectedServiceBrokerState({
                httpPort: 5173,
                connectedServiceBrokerRefreshToken: 'scoped-broker-capability',
            });

            expect(dirname(configuration.connectedServiceBrokerStateFile)).toBe(dirname(configuration.daemonStateFile));
            expect(configuration.connectedServiceBrokerStateFile).not.toBe(configuration.daemonStateFile);
            expect(JSON.parse(readFileSync(configuration.connectedServiceBrokerStateFile, 'utf8'))).toEqual({
                httpPort: 5173,
                connectedServiceBrokerRefreshToken: 'scoped-broker-capability',
            });
            expect(readFileSync(configuration.connectedServiceBrokerStateFile, 'utf8')).not.toContain('broad-control-token');

            await clearDaemonStateForTests({ includeLockFile: false });

            expect(existsSync(configuration.daemonStateFile)).toBe(false);
            expect(existsSync(configuration.connectedServiceBrokerStateFile)).toBe(false);
        });
    });

    it('preserves successor daemon and broker publications during retiring-owner cleanup', async () => {
        await withTempDir('happier-cli-daemon-state-successor-cleanup-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }, {
                clearDaemonState,
                writeConnectedServiceBrokerState,
                writeDaemonState,
            }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);
            const successorDaemonState = {
                pid: 456,
                httpPort: 6173,
                startedAt: 2_000,
                startedWithCliVersion: '0.0.0-current',
                runtimeId: 'runtime-successor',
                controlToken: 'successor-control-token',
            };
            const successorBrokerState = {
                httpPort: 6173,
                connectedServiceBrokerRefreshToken: 'successor-scoped-broker-capability',
            };

            writeDaemonState(successorDaemonState);
            writeConnectedServiceBrokerState(successorBrokerState);
            writeFileSync(configuration.daemonLockFile, String(successorDaemonState.pid), 'utf8');

            const daemonTempPath = `${configuration.daemonStateFile}.tmp-successor-publication`;
            const brokerTempPath = `${configuration.connectedServiceBrokerStateFile}.tmp-successor-publication`;
            const lifecycleLegacyPath = join(dirname(configuration.daemonStateFile), 'daemon.dev.state.json');
            writeFileSync(daemonTempPath, 'successor-daemon-temp', 'utf8');
            writeFileSync(brokerTempPath, 'successor-broker-temp', 'utf8');
            writeFileSync(lifecycleLegacyPath, 'successor-legacy-state', 'utf8');

            await clearDaemonState({
                expectedOwner: {
                    pid: process.pid,
                    startedAt: 1_000,
                },
            });

            expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8'))).toEqual(successorDaemonState);
            expect(JSON.parse(readFileSync(configuration.connectedServiceBrokerStateFile, 'utf8'))).toEqual(successorBrokerState);
            expect(readFileSync(configuration.daemonLockFile, 'utf8')).toBe(String(successorDaemonState.pid));
            expect(readFileSync(daemonTempPath, 'utf8')).toBe('successor-daemon-temp');
            expect(readFileSync(brokerTempPath, 'utf8')).toBe('successor-broker-temp');
            expect(readFileSync(lifecycleLegacyPath, 'utf8')).toBe('successor-legacy-state');
        });
    });

    it('removes the current owner daemon and exact broker publications during shutdown cleanup', async () => {
        await withTempDir('happier-cli-daemon-state-owned-cleanup-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
            });

            const [{ configuration }, {
                clearDaemonState,
                writeConnectedServiceBrokerState,
                writeDaemonState,
            }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);
            const brokerState = {
                httpPort: 5173,
                connectedServiceBrokerRefreshToken: 'current-scoped-broker-capability',
            };

            writeDaemonState({
                pid: process.pid,
                httpPort: 5173,
                startedAt: 1_000,
                startedWithCliVersion: '0.0.0-current',
                runtimeId: 'runtime-current',
                lastHeartbeatAt: 2_000,
                controlToken: 'current-control-token',
            });
            writeConnectedServiceBrokerState(brokerState);
            writeFileSync(configuration.daemonLockFile, String(process.pid), 'utf8');
            const daemonTempPath = `${configuration.daemonStateFile}.tmp-retiring-owner`;
            const brokerTempPath = `${configuration.connectedServiceBrokerStateFile}.tmp-retiring-owner`;
            const lifecycleLegacyPath = join(dirname(configuration.daemonStateFile), 'daemon.dev.state.json');
            writeFileSync(daemonTempPath, 'retiring-daemon-temp', 'utf8');
            writeFileSync(brokerTempPath, 'retiring-broker-temp', 'utf8');
            writeFileSync(lifecycleLegacyPath, 'retiring-legacy-state', 'utf8');

            await expect(clearDaemonState({
                expectedOwner: {
                    pid: process.pid,
                    startedAt: 1_000,
                },
            })).resolves.toBe(true);

            expect(existsSync(configuration.daemonStateFile)).toBe(false);
            expect(existsSync(configuration.connectedServiceBrokerStateFile)).toBe(false);
            expect(existsSync(daemonTempPath)).toBe(false);
            expect(existsSync(brokerTempPath)).toBe(false);
            expect(existsSync(lifecycleLegacyPath)).toBe(false);
        });
    });

    it('does not let an external retiring owner remove a broker descriptor', async () => {
        await withTempDir('happier-cli-daemon-state-successor-before-broker-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
            });

            const [{ configuration }, {
                clearDaemonState,
                writeConnectedServiceBrokerState,
                writeDaemonState,
            }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);
            const retiringBrokerState = {
                httpPort: 5173,
                connectedServiceBrokerRefreshToken: 'retiring-scoped-broker-capability',
            };
            const successorDaemonState = {
                pid: 456,
                httpPort: 6173,
                startedAt: 2_000,
                startedWithCliVersion: '0.0.0-current',
                runtimeId: 'runtime-successor',
                controlToken: 'successor-control-token',
            };

            writeDaemonState(successorDaemonState);
            writeConnectedServiceBrokerState(retiringBrokerState);

            await expect(clearDaemonState({
                expectedOwner: {
                    pid: 123,
                    startedAt: 1_000,
                },
            })).resolves.toBe(false);

            expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8'))).toEqual(successorDaemonState);
            expect(JSON.parse(readFileSync(configuration.connectedServiceBrokerStateFile, 'utf8'))).toEqual(retiringBrokerState);
        });
    });
});
