import { describe, expect, it } from 'vitest';

import {
  resolveEntrypointIdentityFromLaunchSpec,
  resolveSessionRunnerEntrypointIdentityFromProcessCommand,
} from './resolveRunnerEntrypointIdentity';

describe('resolveSessionRunnerEntrypointIdentityFromProcessCommand', () => {
  it('parses pinned Happier CLI package-dist process commands', () => {
    const identity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node --no-warnings /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
    );

    expect(identity).toEqual(expect.objectContaining({
      status: 'known',
      source: 'process_command',
      entrypointVersion: '0.2.10',
      comparableId: 'version:0.2.10',
    }));
  });

  it('parses quoted Windows pinned package-dist process commands', () => {
    const identity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      '"C:\\Program Files\\nodejs\\node.exe" "--no-warnings" "C:\\Users\\alice\\.happier\\cli\\versions\\0.2.11\\package-dist\\index.mjs" codex --started-by daemon',
    );

    expect(identity).toEqual(expect.objectContaining({
      status: 'known',
      source: 'process_command',
      entrypointVersion: '0.2.11',
      comparableId: 'version:0.2.11',
    }));
  });

  it('fails closed for mutable pointer commands', () => {
    const identity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node /Users/alice/.happier/cli-dev/current/package-dist/index.mjs claude --started-by daemon',
    );

    expect(identity).toEqual(expect.objectContaining({
      status: 'unknown',
      reason: 'mutable_entrypoint_pointer',
    }));
  });
});

describe('resolveEntrypointIdentityFromLaunchSpec', () => {
  it('derives current launch identity from the canonical launch spec entrypoint', () => {
    const identity = resolveEntrypointIdentityFromLaunchSpec({
      runtime: 'node',
      filePath: '/usr/local/bin/node',
      args: [
        '--no-warnings',
        '/Users/alice/.happier/cli-dev/versions/0.2.12/package-dist/index.mjs',
        'daemon',
        'start-sync',
      ],
    });

    expect(identity).toEqual(expect.objectContaining({
      status: 'known',
      source: 'launch_spec',
      entrypointVersion: '0.2.12',
      comparableId: 'version:0.2.12',
    }));
  });
});
