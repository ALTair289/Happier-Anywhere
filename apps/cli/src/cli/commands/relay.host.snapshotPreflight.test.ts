import { afterEach, describe, expect, it, vi } from 'vitest';

const preflightSnapshot = vi.fn(async () => ({
  target: 'local' as const,
  platform: 'win32',
  channel: 'stable' as const,
  mode: 'user' as const,
  managedServiceInactive: true,
  currentBinaryProcessCountZero: true,
  writerStopped: false,
  sourceStateReady: true,
  snapshotCreationSupported: false,
  canCreateSnapshot: false,
  coverage: {
    sqliteDatabase: true,
    sqliteWal: 'present' as const,
    sqliteShm: 'present' as const,
    files: true,
    privateFiles: true,
    masterSecret: true,
    effectiveConfig: true,
    serviceMetadata: true,
    installMetadata: true,
  },
  blockers: [
    'global_writer_exclusion_unverified',
    'acl_snapshot_backend_unverified',
  ],
}));

vi.mock('@happier-dev/cli-common/relayHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/relayHost')>();
  return {
    ...actual,
    createRelayHostEngine: () => ({
      readStatus: async () => ({
        installed: true,
        version: '0.2.10',
        service: { active: false, enabled: true },
        baseUrl: 'http://127.0.0.1:3005',
        healthy: false,
      }),
      installOrUpdate: async () => ({ relayUrl: 'http://127.0.0.1:3005', mode: 'user' as const }),
      control: async () => undefined,
      preflightSnapshot,
    }),
  };
});

describe('happier relay host snapshot preflight', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    preflightSnapshot.mockClear();
  });

  it('returns a non-secret BLOCKED envelope instead of pretending an ACL-safe snapshot was created', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.exitCode = undefined;
    const { runRelayHostSubcommand } = await import('./relay/host');

    await runRelayHostSubcommand(['snapshot', '--preflight', '--json']);

    expect(preflightSnapshot).toHaveBeenCalledWith({
      target: { kind: 'local' },
      channel: 'stable',
      mode: 'user',
    });
    const envelope = JSON.parse(String(log.mock.calls[0]?.[0] ?? ''));
    expect(envelope).toMatchObject({
      v: 1,
      ok: false,
      kind: 'relay_host_snapshot_preflight',
      error: {
        code: 'snapshot_blocked',
        details: {
          writerStopped: false,
          sourceStateReady: true,
          canCreateSnapshot: false,
          blockers: [
            'global_writer_exclusion_unverified',
            'acl_snapshot_backend_unverified',
          ],
        },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain('HANDY_MASTER_SECRET');
    expect(process.exitCode).toBe(1);
  });

  it('does not expose a snapshot creation operation before the ACL-preserving backend is verified', async () => {
    const { runRelayHostSubcommand } = await import('./relay/host');

    await expect(runRelayHostSubcommand(['snapshot', '--json'])).rejects.toThrow(/ACL-preserving.*--preflight/i);
    expect(preflightSnapshot).not.toHaveBeenCalled();
  });

  it('rejects install-only flags instead of silently ignoring them during snapshot preflight', async () => {
    const { runRelayHostSubcommand } = await import('./relay/host');

    await expect(runRelayHostSubcommand([
      'snapshot',
      '--preflight',
      '--env',
      'HAPPIER_SERVER_LIGHT_DATA_DIR=C:\\unexpected',
      '--preserve-active-server',
      '--yes',
    ])).rejects.toThrow(/--env.*--preserve-active-server.*--yes.*cannot be used/i);
    expect(preflightSnapshot).not.toHaveBeenCalled();
  });

  it('applies the shared fail-closed SSH target and port contract', async () => {
    const { runRelayHostSubcommand } = await import('./relay/host');

    await expect(runRelayHostSubcommand([
      'snapshot',
      '--preflight',
      '--ssh',
      '-ProxyCommand=unexpected',
    ])).rejects.toThrow(/option-like targets are not allowed/i);
    await expect(runRelayHostSubcommand([
      'snapshot',
      '--preflight',
      '--ssh',
      'dev@example.test',
      '--port',
      '70000',
    ])).rejects.toThrow(/integer from 1 through 65535/i);
    expect(preflightSnapshot).not.toHaveBeenCalled();
  });

  it('rejects SSH connection flags when --ssh is absent', async () => {
    const { runRelayHostSubcommand } = await import('./relay/host');

    await expect(runRelayHostSubcommand([
      'snapshot',
      '--preflight',
      '--port',
      '22',
    ])).rejects.toThrow(/require --ssh/i);
    expect(preflightSnapshot).not.toHaveBeenCalled();
  });
});
