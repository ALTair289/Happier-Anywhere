import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildHandoffSessionMetadataFromTrackedSession } from './buildHandoffSessionMetadataFromTrackedSession';

describe('buildHandoffSessionMetadataFromTrackedSession', () => {
  it('keeps provider-specific handoff metadata behind backend catalog hooks', async () => {
    const sourcePath = fileURLToPath(new URL('./buildHandoffSessionMetadataFromTrackedSession.ts', import.meta.url));
    const source = await readFile(sourcePath, 'utf8');

    expect(source).not.toContain('@/backends/claude/');
    expect(source).not.toContain("case 'claude'");
    expect(source).not.toContain("case 'codex'");
    expect(source).not.toContain("case 'opencode'");
  });

  it('builds Claude direct-session runtime-local metadata through the provider handoff hook', () => {
    const metadata = buildHandoffSessionMetadataFromTrackedSession({
      trackedSession: {
        startedBy: 'daemon',
        pid: 123,
        happySessionId: 'sess_handoff_direct',
        vendorResumeId: 'claude-vendor-session',
        happySessionMetadataFromLocalWebhook: {
          machineId: 'machine-source',
          path: '/repo-source',
          homeDir: '/Users/source',
          flavor: 'claude',
        },
        spawnOptions: {
          transcriptStorage: 'direct',
          environmentVariables: {
            CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          },
        },
      } as never,
      machineId: 'machine-source',
    });

    expect(metadata).toEqual(expect.objectContaining({
      runtimeLocalMetadata: expect.objectContaining({
        claudeSessionId: 'claude-vendor-session',
        directSessionV1: expect.objectContaining({
          v: 1,
          providerId: 'claude',
          machineId: 'machine-source',
          remoteSessionId: 'claude-vendor-session',
          source: expect.objectContaining({
            kind: 'claudeConfig',
            configDir: '/tmp/claude-config',
            projectId: expect.any(String),
          }),
          linkedAtMs: expect.any(Number),
        }),
      }),
    }));
  });

  it('builds Codex runtime-local resume metadata through the provider handoff hook', () => {
    const metadata = buildHandoffSessionMetadataFromTrackedSession({
      trackedSession: {
        startedBy: 'daemon',
        pid: 124,
        happySessionId: 'sess_handoff_codex',
        vendorResumeId: 'codex-vendor-session',
        happySessionMetadataFromLocalWebhook: {
          machineId: 'machine-source',
          path: '/repo-source',
          homeDir: '/Users/source',
          flavor: 'codex',
        },
      } as never,
      machineId: 'machine-source',
    });

    expect(metadata).toEqual(expect.objectContaining({
      runtimeLocalMetadata: expect.objectContaining({
        codexSessionId: 'codex-vendor-session',
      }),
    }));
  });

  it('builds OpenCode runtime-local resume metadata through the provider handoff hook', () => {
    const metadata = buildHandoffSessionMetadataFromTrackedSession({
      trackedSession: {
        startedBy: 'daemon',
        pid: 125,
        happySessionId: 'sess_handoff_opencode',
        vendorResumeId: 'opencode-vendor-session',
        happySessionMetadataFromLocalWebhook: {
          machineId: 'machine-source',
          path: '/repo-source',
          homeDir: '/Users/source',
          flavor: 'opencode',
        },
      } as never,
      machineId: 'machine-source',
    });

    expect(metadata).toEqual(expect.objectContaining({
      runtimeLocalMetadata: expect.objectContaining({
        opencodeSessionId: 'opencode-vendor-session',
      }),
    }));
  });
});
