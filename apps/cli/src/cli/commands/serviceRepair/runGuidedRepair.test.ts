import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunningDaemonCliMismatch } from '@/diagnostics/doctorRepair';

const {
  buildHappyCliSubprocessLaunchSpecMock,
  promptInputMock,
  spawnSyncMock,
} = vi.hoisted(() => ({
  buildHappyCliSubprocessLaunchSpecMock: vi.fn((args: string[]) => ({
    runtime: 'node' as const,
    filePath: '/opt/happier/bin/happier',
    args,
    env: undefined,
  })),
  promptInputMock: vi.fn(async () => ''),
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock('@/terminal/prompts/promptInput', () => ({
  promptInput: promptInputMock,
}));

vi.mock('@/utils/spawnHappyCLI', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/spawnHappyCLI')>();
  return {
    ...actual,
    buildHappyCliSubprocessLaunchSpec: buildHappyCliSubprocessLaunchSpecMock,
  };
});

function makeRunningDaemonCliMismatch(): RunningDaemonCliMismatch {
  return {
    kind: 'running_daemon_cli_mismatch',
    severity: 'warning',
    autoApplyWithoutPrompt: false,
    daemon: {
      serverId: 'default',
      pid: 4321,
      httpPort: 41234,
      startedBy: 'manual',
      startedWithReleaseChannel: 'dev',
      startedWithCliVersion: '0.11.9',
      matchesCurrentCli: false,
      staleStateFile: false,
    },
    currentCliReleaseChannel: 'dev',
    currentCliVersion: '0.12.0',
    driftKind: 'version-only',
    recoveryStrategy: 'daemon-takeover',
    serviceManagerName: null,
  };
}

describe('runGuidedRepair running daemon CLI mismatch repair', () => {
  afterEach(() => {
    buildHappyCliSubprocessLaunchSpecMock.mockClear();
    promptInputMock.mockReset();
    promptInputMock.mockImplementation(async () => '');
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation(() => ({ status: 0 }));
    vi.restoreAllMocks();
  });

  it('keeps the default interactive answer on daemon restart only', async () => {
    const { runGuidedRepair } = await import('./runGuidedRepair');

    await runGuidedRepair({
      findings: [makeRunningDaemonCliMismatch()],
      currentCli: {
        releaseChannel: 'dev',
        version: '0.12.0',
        invoker: 'happier',
      },
    });

    expect(buildHappyCliSubprocessLaunchSpecMock).toHaveBeenCalledWith([
      'daemon',
      'restart',
      '--takeover',
    ]);
    expect(buildHappyCliSubprocessLaunchSpecMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['--restart-session-runners']),
    );
  });

  it('can explicitly restart eligible session runners through the daemon restart command path', async () => {
    promptInputMock.mockResolvedValueOnce('r');
    const { runGuidedRepair } = await import('./runGuidedRepair');

    await runGuidedRepair({
      findings: [makeRunningDaemonCliMismatch()],
      currentCli: {
        releaseChannel: 'dev',
        version: '0.12.0',
        invoker: 'happier',
      },
    });

    expect(buildHappyCliSubprocessLaunchSpecMock).toHaveBeenCalledWith([
      'daemon',
      'restart',
      '--takeover',
      '--restart-session-runners',
    ]);
  });
});
