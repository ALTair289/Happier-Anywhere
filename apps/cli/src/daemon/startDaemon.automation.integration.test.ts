import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;

const automationCredentials = {
  token: 'token-automation',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
};

function createRegisteredMachine(machineId: string) {
  return {
    id: machineId,
    encryptionKey: new Uint8Array([1, 2, 3, 4]),
    encryptionVariant: 'legacy' as const,
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  attempts: number = 400,
  intervalMs: number = 5,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function resetAutomationDaemonTestDefaults(): Promise<void> {
  const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
  vi.mocked(ensureMachineRegistered).mockReset();
  vi.mocked(ensureMachineRegistered).mockImplementation(async ({ machineId }: { machineId: string }) => ({
    machineId,
    didRotateMachineId: false,
    machine: createRegisteredMachine(machineId),
  }));

  const { isDaemonRunningCurrentlyInstalledHappyVersion } = await import('./controlClient');
  vi.mocked(isDaemonRunningCurrentlyInstalledHappyVersion).mockReset();
  vi.mocked(isDaemonRunningCurrentlyInstalledHappyVersion).mockResolvedValue(false);
}

const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
  let machineConnectionStateListener: ((state: any) => void) | null = null;
  let autoShutdownAfterAutomationStart = true;
  let activeAccountSettingsSnapshot: { settingsVersion: number } | null = null;
  const machineUpdateListeners: Array<(update: any) => boolean | void> = [];
  const accountSettingsVersionHintListeners: Array<(hint: { settingsVersion: number | null; source: string }) => void> = [];

  const automationWorkerStop = vi.fn();
  const automationWorkerRefreshAssignments = vi.fn(async () => {});
  const automationWorkerPause = vi.fn();
  const automationWorkerResume = vi.fn();
  const startAutomationWorker = vi.fn(() => {
    if (autoShutdownAfterAutomationStart && requestShutdownRef) {
      setTimeout(() => requestShutdownRef?.('happier-cli'), 0);
    }
    return {
      stop: automationWorkerStop,
      refreshAssignments: automationWorkerRefreshAssignments,
      pause: automationWorkerPause,
      resume: automationWorkerResume,
      handleServerUpdate: vi.fn(),
    };
  });

  const connectedServiceQuotasPause = vi.fn();
  const connectedServiceQuotasResume = vi.fn();
  const connectedServiceQuotasStop = vi.fn();
  const startConnectedServiceQuotasLoop = vi.fn(() => ({
    stop: connectedServiceQuotasStop,
    pause: connectedServiceQuotasPause,
    resume: connectedServiceQuotasResume,
  }));

  const apiMachine = {
    setRPCHandlers: vi.fn(),
    onUpdate: vi.fn((listener: (update: any) => boolean | void) => {
      machineUpdateListeners.push(listener);
      return () => {
        const index = machineUpdateListeners.indexOf(listener);
        if (index >= 0) {
          machineUpdateListeners.splice(index, 1);
        }
      };
    }),
    onAccountSettingsVersionHint: vi.fn((listener: (hint: { settingsVersion: number | null; source: string }) => void) => {
      accountSettingsVersionHintListeners.push(listener);
      return () => {
        const index = accountSettingsVersionHintListeners.indexOf(listener);
        if (index >= 0) {
          accountSettingsVersionHintListeners.splice(index, 1);
        }
      };
    }),
    onConnectionStateChange: vi.fn((listener: (state: any) => void) => {
      machineConnectionStateListener = listener;
      return () => {
        if (machineConnectionStateListener === listener) {
          machineConnectionStateListener = null;
        }
      };
    }),
    connect: vi.fn((params?: { onConnect?: () => void | Promise<void> }) => {
      // Simulate a reconnect so we can assert automation assignment refresh isn't
      // blocked after the one-time metadata refresh.
      void params?.onConnect?.();
      void params?.onConnect?.();
    }),
    updateMachineMetadata: vi.fn(async () => {}),
    updateDaemonState: vi.fn(async () => {}),
    shutdown: vi.fn(),
  };
  const machineSyncClient = vi.fn(() => apiMachine);

  const lockHandle = { release: vi.fn(async () => {}) };

  const createDaemonShutdownController = vi.fn(() => {
    const resolvesWhenShutdownRequested = new Promise<{ source: ShutdownSource; errorMessage?: string }>((resolve) => {
      resolveShutdown = resolve;
    });
    const requestShutdown = (source: ShutdownSource, errorMessage?: string) => {
      resolveShutdown?.({ source, errorMessage });
    };
    requestShutdownRef = requestShutdown;
    return {
      requestShutdown,
      resolvesWhenShutdownRequested,
    };
  });

  return {
    startAutomationWorker,
    automationWorkerStop,
    automationWorkerRefreshAssignments,
    automationWorkerPause,
    automationWorkerResume,
    apiMachine,
    machineSyncClient,
    lockHandle,
    startConnectedServiceQuotasLoop,
    connectedServiceQuotasPause,
    connectedServiceQuotasResume,
    connectedServiceQuotasStop,
    createDaemonShutdownController,
    emitMachineConnectionState: (state: any) => machineConnectionStateListener?.(state),
    setAutoShutdownAfterAutomationStart: (value: boolean) => {
      autoShutdownAfterAutomationStart = value;
    },
    setActiveAccountSettingsSnapshot: (snapshot: { settingsVersion: number } | null) => {
      activeAccountSettingsSnapshot = snapshot;
    },
    getActiveAccountSettingsSnapshot: () => activeAccountSettingsSnapshot,
    machineUpdateListeners,
    resetMachineUpdateListeners: () => {
      machineUpdateListeners.splice(0, machineUpdateListeners.length);
    },
    accountSettingsVersionHintListeners,
    resetAccountSettingsVersionHintListeners: () => {
      accountSettingsVersionHintListeners.splice(0, accountSettingsVersionHintListeners.length);
    },
    requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
    bootstrapAccountSettingsContext: vi.fn(async (_params?: unknown) => ({
      source: 'network',
      settings: { schemaVersion: 2 },
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
    })),
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => ({
      machineSyncClient: harness.machineSyncClient,
    })),
  },
  isMachineContentPublicKeyMismatchError: vi.fn(() => false),
}));

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: vi.fn(async ({ machineId }: { machineId: string }) => ({
    machineId,
    didRotateMachineId: false,
    machine: createRegisteredMachine(machineId),
  })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    logFilePath: '/tmp/happier-daemon.log',
  },
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(async () => ({
    credentials: automationCredentials,
    machineId: 'machine-automation',
  })),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    privateKeyFile: '/tmp/key',
    happyHomeDir: '/tmp/home',
    currentCliVersion: '0.0.0-test',
    publicReleaseRing: 'stable',
    activeServerId: 'default',
    serverUrl: 'https://api.happier.dev',
    apiServerUrl: 'https://api.happier.dev',
    webappUrl: 'https://happier.dev',
    activeServerDir: '/tmp/server',
    daemonSpawnExistingSessionWaitForExitMs: 5_000,
    daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
  },
}));

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: vi.fn(() => false),
  stopCaffeinate: vi.fn(async () => {}),
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessInvocation: vi.fn(),
  buildHappyCliSubprocessLaunchSpec: vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
  spawnHappyCLI: vi.fn(),
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: {},
  getConnectedServiceRuntimeAuthAdapter: vi.fn(() => null),
  getVendorResumeSupport: vi.fn(async () => () => true),
  requireCatalogEntry: vi.fn(() => ({})),
  resolveConnectedServiceCredentialLifecycleDescriptor: vi.fn(() => null),
  resolveConnectedServiceSwitchContinuity: vi.fn(() => null),
  resolveAgentCliSubcommand: vi.fn(),
  resolveCatalogAgentId: vi.fn(() => 'codex'),
}));

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
  acquireDaemonLock: vi.fn(async () => harness.lockHandle),
  releaseDaemonLock: vi.fn(async () => {}),
  readCredentials: vi.fn(async () => null),
  readSettings: vi.fn(async () => ({ experiments: true })),
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: vi.fn(() => harness.getActiveAccountSettingsSnapshot()),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: harness.bootstrapAccountSettingsContext,
}));

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
  refreshAccountSettingsForMinimumVersion: vi.fn(async (params: { credentials: unknown; minSettingsVersion?: number | null; mode?: string; forceRefresh?: boolean }) => {
    const active = harness.getActiveAccountSettingsSnapshot();
    if (
      !params.forceRefresh
      &&
      typeof params.minSettingsVersion === 'number'
      && active
      && active.settingsVersion >= params.minSettingsVersion
    ) {
      return {
        source: 'cache',
        settings: { schemaVersion: 2 },
        settingsVersion: active.settingsVersion,
        loadedAtMs: Date.now(),
        settingsSecretsReadKeys: [],
        whenRefreshed: null,
      };
    }
    return await harness.bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: params.mode ?? 'blocking',
      refresh: params.forceRefresh ? 'force' : 'auto',
      ...(typeof params.minSettingsVersion === 'number' ? { minSettingsVersion: params.minSettingsVersion } : {}),
    });
  }),
}));

vi.mock('./controlClient', () => ({
  cleanupDaemonState: vi.fn(async () => {}),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
  resolveDaemonSpawnSessionByNonce: vi.fn(async () => null),
  stopDaemon: vi.fn(async () => {}),
}));

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
  evaluateDaemonStartupServiceConflict: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('./controlServer', () => ({
  startDaemonControlServer: vi.fn(async () => ({
    port: 43210,
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock('./sessions/reattachFromMarkers', () => ({
  reattachTrackedSessionsFromMarkers: vi.fn(async () => ({
    orphanedDeadDaemonSessions: [],
  })),
}));

vi.mock('./sessions/onHappySessionWebhook', () => ({
  createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/onChildExited', () => ({
  createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: vi.fn(async () => null),
}));

vi.mock('./sessions/stopSession', () => ({
  createStopSession: vi.fn(() => vi.fn(async () => ({ stopped: true }))),
}));

vi.mock('./sessions/resolveSpawnWebhookResult', () => ({
  resolveSpawnWebhookResult: vi.fn(({ result }) => result),
}));

vi.mock('./lifecycle/heartbeat', () => ({
  startDaemonHeartbeatLoop: vi.fn(() => setInterval(() => {}, 60_000)),
}));

vi.mock('@/projectPath', () => ({
  projectPath: vi.fn(() => '/tmp/project'),
}));

vi.mock('@/integrations/tmux', () => ({
  selectPreferredTmuxSessionName: vi.fn(),
  TmuxUtilities: {},
  isTmuxAvailable: vi.fn(() => false),
}));

vi.mock('@/terminal/runtime/terminalConfig', () => ({
  resolveTerminalRequestFromSpawnOptions: vi.fn(() => ({ requested: null })),
}));

vi.mock('@/terminal/runtime/envVarSanitization', () => ({
  validateEnvVarRecordStrict: vi.fn(() => ({ ok: true, env: {} })),
}));

vi.mock('./machine/metadata', () => ({
  getPreferredHostName: vi.fn(async () => 'host.local'),
  initialMachineMetadata: {},
}));

vi.mock('./lifecycle/shutdown', () => ({
  createDaemonShutdownController: harness.createDaemonShutdownController,
}));

vi.mock('./platform/tmux/spawnConfig', () => ({
  buildTmuxSpawnConfig: vi.fn(),
  buildTmuxWindowEnv: vi.fn(),
}));

vi.mock('./platform/windows/windowsSessionConsoleMode', () => ({
  resolveWindowsRemoteSessionConsoleMode: vi.fn(),
}));

vi.mock('./platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: vi.fn(),
}));

vi.mock('./sessionSpawnArgs', () => ({
  buildHappySessionControlArgs: vi.fn(() => []),
}));

vi.mock('./startup/waitForAuthConfig', () => ({
  resolveWaitForAuthConfig: vi.fn(() => ({
    waitForAuthEnabled: false,
    waitForAuthTimeoutMs: 0,
  })),
}));

vi.mock('./startup/ensureSessionDirectory', () => ({
  ensureSessionDirectory: vi.fn(async () => ({ ok: true, directoryCreated: false })),
}));

vi.mock('./startup/waitForInitialCredentials', () => ({
  waitForInitialCredentials: vi.fn(async () => ({
    action: 'continue',
    daemonLockHandle: harness.lockHandle,
  })),
}));

vi.mock('./spawn/waitForSessionWebhook', () => ({
  waitForSessionWebhook: vi.fn(async () => null),
}));

vi.mock('./spawn/resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: vi.fn(async () => ({
    ok: true,
    env: {},
    cleanupOnFailure: null,
    cleanupOnExit: null,
  })),
}));

vi.mock('./automation/automationWorker', () => ({
  startAutomationWorker: harness.startAutomationWorker,
}));

vi.mock('./memory/memoryWorker', () => ({
  startMemoryWorker: vi.fn(async () => null),
}));

vi.mock('./connectedServices/quotas/ConnectedServiceQuotasCoordinator', () => ({
  ConnectedServiceQuotasCoordinator: vi.fn(() => ({
    flushInBandQuotaPersistence: vi.fn(async () => ({ timedOut: false })),
    notifyQuotaPersistenceConnectivityChanged: vi.fn(),
    dispose: vi.fn(),
    registerSpawnTarget: vi.fn(),
    unregisterPid: vi.fn(),
    transferPid: vi.fn(),
    hydratePersistedQuotaSnapshotsForGroup: vi.fn(async () => {}),
    probeGroupQuotaSnapshots: vi.fn(async () => {}),
    handleAccountUsageChanged: vi.fn(async () => {}),
    consumeRecoveryCreditForProfile: vi.fn(async () => null),
  })),
}));

vi.mock('./connectedServices/quotas/createConnectedServiceQuotaFetchers', () => ({
  createConnectedServiceQuotaFetchers: vi.fn(() => []),
}));

vi.mock('./connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions', () => ({
  resolveConnectedServiceQuotasDaemonOptions: vi.fn(() => ({
    fetchTimeoutMs: 1_000,
    discoveryEnabled: false,
    discoveryIntervalMs: 60_000,
    failureBackoffMinMs: 1_000,
    failureBackoffMaxMs: 60_000,
    failureBackoffJitterPct: 0,
  })),
}));

vi.mock('./connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled', () => ({
  resolveConnectedServicesQuotasDaemonEnabled: vi.fn(async () => true),
}));

vi.mock('./connectedServices/quotas/startConnectedServiceQuotasLoop', () => ({
  startConnectedServiceQuotasLoop: harness.startConnectedServiceQuotasLoop,
}));

vi.mock('./connectedServices/accountUsage/hydration', () => ({
  hydrateProviderAccountUsageStoreFromSessionMetadata: vi.fn(async () => ({ hydratedRecordIds: [] })),
}));

vi.mock('./shutdownPolicy', () => ({
  getDaemonShutdownExitCode: vi.fn(() => 0),
  getDaemonShutdownWatchdogTimeoutMs: vi.fn(() => 10_000),
}));

vi.mock('@/machines/transfer/directPeerTransport', () => ({
  createDirectPeerTransferRegistry: vi.fn(() => ({
    publishTransfer: vi.fn(() => ({
      endpointCandidates: [],
      expiresAt: 30_000,
    })),
    readPublishedTransfer: vi.fn(() => null),
    resolveOnDemandTransferOnOpen: vi.fn(async () => null),
    clearPublishedTransfer: vi.fn(),
  })),
  requestDirectPeerTransferToFile: vi.fn(async ({ destinationPath }: { destinationPath: string }) => ({
    destinationPath,
    manifestHash: 'sha256:test-manifest',
    sizeBytes: 0,
  })),
  startDirectPeerTransferServer: vi.fn(async () => ({
    port: 46001,
    stop: vi.fn(async () => {}),
  })),
}));

describe('startDaemon automation wiring (integration)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    harness.setAutoShutdownAfterAutomationStart(true);
    harness.setActiveAccountSettingsSnapshot(null);
    harness.resetMachineUpdateListeners();
    harness.resetAccountSettingsVersionHintListeners();
    await resetAutomationDaemonTestDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    harness.setAutoShutdownAfterAutomationStart(true);
  });

  it('checks same-version daemon compatibility after auth resolves the current machine id', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { authAndSetupMachineIfNeeded } = await import('@/ui/auth');
      const { isDaemonRunningCurrentlyInstalledHappyVersion } = await import('./controlClient');
      (isDaemonRunningCurrentlyInstalledHappyVersion as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce(true);

      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      expect(authAndSetupMachineIfNeeded).toHaveBeenCalledTimes(1);
      expect(isDaemonRunningCurrentlyInstalledHappyVersion).toHaveBeenCalledWith({
        expectedMachineId: 'machine-automation',
      });
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('restarts a same-version daemon when machine registration rotates the machine id before startup', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      const ensureMachineRegisteredMock = ensureMachineRegistered as unknown as {
        mockImplementation: (impl: (params: { machineId: string }) => unknown) => void;
      };
      ensureMachineRegisteredMock.mockImplementation(async ({ machineId }: { machineId: string }) => {
        const resolvedMachineId = machineId === 'machine-automation' ? 'machine-rotated' : machineId;
        return {
          machineId: resolvedMachineId,
          didRotateMachineId: resolvedMachineId !== machineId,
          machine: createRegisteredMachine(resolvedMachineId),
        };
      });

      const { isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } = await import('./controlClient');
      (isDaemonRunningCurrentlyInstalledHappyVersion as unknown as {
        mockImplementation: (impl: (params?: { expectedMachineId?: string | null }) => boolean) => void;
      }).mockImplementation((params?: { expectedMachineId?: string | null }) => (
        params?.expectedMachineId === 'machine-automation'
      ));

      const { writeDaemonState } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      await waitForCondition(
        () => harness.startAutomationWorker.mock.calls.length >= 1,
        'Expected automation worker to start after machine registration rotation',
      );

      expect(stopDaemon).toHaveBeenCalledTimes(1);
      expect(writeDaemonState).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine-rotated',
      }));
      expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('backs off machine registration retries after transient failures', async () => {
    vi.useRealTimers();
    harness.setAutoShutdownAfterAutomationStart(false);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const retryBaseDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS;
    const retryDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS;
    const retryMaxDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS;
    const retryJitterOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS;
    delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS;
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS = '100';
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS = '1000';
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS = '0';

    let run: Promise<void> | null = null;
    try {
      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      const ensureMachineRegisteredMock = vi.mocked(ensureMachineRegistered);
      const firstAttempt = createDeferred<Awaited<ReturnType<typeof ensureMachineRegistered>>>();
      const secondAttempt = createDeferred<Awaited<ReturnType<typeof ensureMachineRegistered>>>();
      ensureMachineRegisteredMock
        .mockImplementationOnce(() => firstAttempt.promise)
        .mockImplementationOnce(() => secondAttempt.promise);

      const { startDaemon } = await import('./startDaemon');

      run = startDaemon();
      await waitForCondition(
        () => ensureMachineRegisteredMock.mock.calls.length >= 1 || exitSpy.mock.calls.length >= 1,
        'Expected machine registration loop to start the first attempt',
        400,
      );
      if (ensureMachineRegisteredMock.mock.calls.length === 0) {
        const { logger } = await import('@/ui/logger');
        const debugCalls = vi.mocked(logger.debug).mock.calls.slice(-3);
        throw new Error(`Expected machine registration loop to start before daemon exit: ${JSON.stringify(debugCalls)}`);
      }

      vi.useFakeTimers();
      firstAttempt.reject(new Error('transient machine registration failure 1'));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(99);
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(2);

      secondAttempt.reject(new Error('transient machine registration failure 2'));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(199);
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await vi.advanceTimersByTimeAsync(0);
      await run;
    } finally {
      harness.requestShutdown('happier-cli');
      if (run) {
        if (vi.isFakeTimers()) {
          await vi.advanceTimersByTimeAsync(0);
        }
        await run;
      }
      if (retryBaseDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS = retryBaseDelayOriginal;
      }
      if (retryDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS = retryDelayOriginal;
      }
      if (retryMaxDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS = retryMaxDelayOriginal;
      }
      if (retryJitterOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS = retryJitterOriginal;
      }
      vi.useRealTimers();
      exitSpy.mockRestore();
    }
  });

  it('writes daemon state even when machine registration fails', async () => {
    vi.useRealTimers();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      (ensureMachineRegistered as unknown as { mockRejectedValue: (value: unknown) => void }).mockRejectedValue(
        new Error('machine registration failure'),
      );

      const { writeDaemonState } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      const writeDaemonStateMock = writeDaemonState as unknown as { mock: { calls: unknown[][] } };
      await waitForCondition(
        () => writeDaemonStateMock.mock.calls.length >= 1,
        'Expected daemon state to be written before machine registration succeeds',
      );

      expect(writeDaemonState).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('writes daemon state before passive provider-account usage hydration completes', async () => {
    vi.useRealTimers();
    harness.setAutoShutdownAfterAutomationStart(false);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const hydration = createDeferred<{ hydratedRecordIds: string[] }>();
    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    let run: Promise<void> | null = null;

    try {
      process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'self-restart';
      const { hydrateProviderAccountUsageStoreFromSessionMetadata } = await import('./connectedServices/accountUsage/hydration');
      vi.mocked(hydrateProviderAccountUsageStoreFromSessionMetadata).mockImplementationOnce(async () => hydration.promise);

      const { writeDaemonState } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');

      run = startDaemon();
      const writeDaemonStateMock = writeDaemonState as unknown as { mock: { calls: unknown[][] } };
      await waitForCondition(
        () => writeDaemonStateMock.mock.calls.length >= 1,
        'Expected daemon state to be written before passive provider-account usage hydration completes',
      );
      await waitForCondition(
        () => vi.mocked(hydrateProviderAccountUsageStoreFromSessionMetadata).mock.calls.length >= 1,
        'Expected passive provider-account usage hydration to start after daemon state is written',
      );

      expect(writeDaemonState).toHaveBeenCalledTimes(1);
      expect(hydrateProviderAccountUsageStoreFromSessionMetadata).toHaveBeenCalledTimes(1);
    } finally {
      hydration.resolve({ hydratedRecordIds: [] });
      harness.requestShutdown('happier-cli');
      if (run) await run;
      if (startupSourceOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      } else {
        process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSourceOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('starts automation worker after machine sync bootstrap and stops it on shutdown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      await waitForCondition(
        () => harness.startAutomationWorker.mock.calls.length >= 1,
        'Expected automation worker to start after machine bootstrap completes',
      );

      expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);
      expect(harness.startAutomationWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'token-automation',
          machineId: 'machine-automation',
        }),
      );
      expect(harness.apiMachine.setRPCHandlers).toHaveBeenCalledTimes(1);
      expect(harness.apiMachine.connect).toHaveBeenCalledTimes(1);
      expect(harness.apiMachine.updateMachineMetadata).toHaveBeenCalledTimes(1);
      expect(harness.automationWorkerRefreshAssignments).toHaveBeenCalledTimes(2);
      await waitForCondition(
        () => harness.automationWorkerStop.mock.calls.length >= 1,
        'Expected automation worker to stop during daemon shutdown cleanup',
      );
      expect(harness.automationWorkerStop).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('warns when connected-service quota persistence does not drain during shutdown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { logger } = await import('@/ui/logger');
      const { ConnectedServiceQuotasCoordinator } = await import('./connectedServices/quotas/ConnectedServiceQuotasCoordinator');
      const flushInBandQuotaPersistence = vi.fn(async () => ({
        timedOut: true,
        inProcess: { timedOut: true, drained: false },
        serverWork: { timedOut: false },
      }));
      vi.mocked(ConnectedServiceQuotasCoordinator).mockImplementationOnce(() => ({
        flushInBandQuotaPersistence,
        notifyQuotaPersistenceConnectivityChanged: vi.fn(),
        dispose: vi.fn(),
        registerSpawnTarget: vi.fn(),
        unregisterPid: vi.fn(),
        transferPid: vi.fn(),
      } as unknown as InstanceType<typeof ConnectedServiceQuotasCoordinator>));

      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      expect(flushInBandQuotaPersistence).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Connected-service quota persistence did not drain before shutdown',
        expect.objectContaining({
          timedOut: true,
          inProcess: { timedOut: true, drained: false },
          serverWork: { timedOut: false },
        }),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('registers a daemon account settings listener that refreshes newer compact live hints', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot({ settingsVersion: 2 });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await waitForCondition(
        () => harness.machineUpdateListeners.length >= 2,
        'Expected daemon machine update listeners to be registered',
      );
      harness.bootstrapAccountSettingsContext.mockClear();

      for (const listener of harness.machineUpdateListeners) {
        listener({
          id: 'upd-settings',
          seq: 5,
          createdAt: Date.now(),
          body: { t: 'account-settings-changed', settingsVersion: 3 },
        });
      }

      await waitForCondition(
        () => harness.bootstrapAccountSettingsContext.mock.calls.length >= 1,
        'Expected account settings refresh to be triggered by newer compact hint',
      );

      expect(harness.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: automationCredentials,
          minSettingsVersion: 3,
          mode: 'blocking',
          refresh: 'auto',
        }),
      );

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('ignores stale or equal daemon account settings live hints', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot({ settingsVersion: 3 });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await waitForCondition(
        () => harness.machineUpdateListeners.length >= 2,
        'Expected daemon machine update listeners to be registered',
      );
      harness.bootstrapAccountSettingsContext.mockClear();

      for (const listener of harness.machineUpdateListeners) {
        listener({
          id: 'upd-settings',
          seq: 5,
          createdAt: Date.now(),
          body: { t: 'account-settings-changed', settingsVersion: 3 },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.bootstrapAccountSettingsContext).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('forces account settings refresh for conservative reconnect hints without a version', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot({ settingsVersion: 3 });

    try {
      const { startDaemon } = await import('./startDaemon');
      const { refreshAccountSettingsForMinimumVersion } = await import('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion');

      const run = startDaemon();
      await waitForCondition(
        () => harness.accountSettingsVersionHintListeners.length >= 1,
        'Expected daemon account settings version hint listener to be registered',
      );

      for (const listener of harness.accountSettingsVersionHintListeners) {
        listener({ settingsVersion: null, source: 'cursor-gone' });
      }

      await waitForCondition(
        () => harness.bootstrapAccountSettingsContext.mock.calls.length >= 1,
        'Expected conservative reconnect hint to force account settings refresh',
      );

      expect(refreshAccountSettingsForMinimumVersion).toHaveBeenCalledWith(expect.objectContaining({
        credentials: automationCredentials,
        minSettingsVersion: null,
        mode: 'blocking',
        forceRefresh: true,
      }));
      expect(harness.bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
        refresh: 'force',
      }));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('uses account settings version hints only for daemon freshness refresh', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      const { startDaemon } = await import('./startDaemon');
      const { buildHappySessionControlArgs } = await import('./sessionSpawnArgs');

      const run = startDaemon();
      await waitForCondition(
        () => harness.apiMachine.setRPCHandlers.mock.calls.length >= 1,
        'Expected daemon RPC handlers to be registered',
      );

      const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0] as {
        spawnSession?: (options: unknown) => Promise<unknown>;
      } | undefined;
      if (typeof handlers?.spawnSession !== 'function') {
        throw new Error('Expected spawnSession handler to be registered');
      }

      const spawnResult = await handlers.spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        accountSettingsVersionHint: 14,
      });

      expect(spawnResult).toEqual(expect.objectContaining({ type: 'error' }));

      expect(buildHappySessionControlArgs).toHaveBeenCalledWith(expect.not.objectContaining({
        accountSettingsVersionHint: expect.any(Number),
      }));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('spawns without an account settings version hint when daemon freshness refresh fails', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot(null);
    harness.bootstrapAccountSettingsContext.mockRejectedValueOnce(
      Object.assign(new Error('Account settings are not fresh enough for this session spawn.'), {
        code: 'ACCOUNT_SETTINGS_STALE',
      }),
    );

    try {
      const { startDaemon } = await import('./startDaemon');
      const { buildHappySessionControlArgs } = await import('./sessionSpawnArgs');
      vi.mocked(buildHappySessionControlArgs).mockClear();

      const run = startDaemon();
      await waitForCondition(
        () => harness.apiMachine.setRPCHandlers.mock.calls.length >= 1,
        'Expected daemon RPC handlers to be registered',
      );

      const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0] as {
        spawnSession?: (options: unknown) => Promise<unknown>;
      } | undefined;
      if (typeof handlers?.spawnSession !== 'function') {
        throw new Error('Expected spawnSession handler to be registered');
      }

      const spawnResult = await handlers.spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        accountSettingsVersionHint: 1_000_000,
      });

      expect(spawnResult).not.toEqual(expect.objectContaining({
        errorCode: 'ACCOUNT_SETTINGS_STALE',
      }));
      expect(buildHappySessionControlArgs).toHaveBeenCalledWith(expect.not.objectContaining({
        accountSettingsVersionHint: expect.any(Number),
      }));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('does not leak bearer tokens when machine registration fails', async () => {
    vi.useRealTimers();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const leakedBearer = 'Bearer super-secret-token';

      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      (ensureMachineRegistered as unknown as { mockRejectedValueOnce: (value: unknown) => void }).mockRejectedValueOnce({
        isAxiosError: true,
        name: 'AxiosError',
        message: 'Request failed with status code 401',
        response: { status: 401 },
        config: {
          method: 'post',
          url: 'http://127.0.0.1:3009/v1/machines',
          headers: { Authorization: leakedBearer },
        },
      });

      const { logger } = await import('@/ui/logger');
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.requestShutdown('happier-cli');
      await run;

      const warnMock = (logger as any).warn as any;
      const debugMock = (logger as any).debug as any;
      const serialized = JSON.stringify([...warnMock.mock.calls, ...debugMock.mock.calls]);
      expect(serialized).not.toContain(leakedBearer);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('pauses daemon background loops until machine connectivity is online and resumes them afterwards', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await waitForCondition(
        () => harness.apiMachine.onConnectionStateChange.mock.calls.length >= 1,
        'Expected machine connection listener to be registered after bootstrap',
      );

      expect(harness.apiMachine.onConnectionStateChange).toHaveBeenCalledTimes(1);

      harness.emitMachineConnectionState({
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
      });

      expect(harness.automationWorkerPause).toHaveBeenCalledTimes(1);

      harness.emitMachineConnectionState({
        phase: 'online',
        reason: 'initial_connect',
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
      });

      expect(harness.automationWorkerResume).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });
});
