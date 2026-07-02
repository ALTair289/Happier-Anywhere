import type { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveDaemonSelfRestartExpectedCliVersion } from './resolveDaemonSelfRestartExpectedCliVersion';

describe('resolveDaemonSelfRestartExpectedCliVersion', () => {
  it('prefers the comparable project version when direct restart launches a newer CLI', () => {
    expect(
      resolveDaemonSelfRestartExpectedCliVersion({
        currentCliVersion: '0.2.8',
        projectRootPath: '/repo/apps/cli',
        readFileSyncImpl: ((() => JSON.stringify({ version: '0.2.10' })) as unknown) as typeof readFileSync,
      }),
    ).toBe('0.2.10');
  });

  it('falls back to the running daemon version when the project package is unavailable', () => {
    expect(
      resolveDaemonSelfRestartExpectedCliVersion({
        currentCliVersion: '0.2.8',
        projectRootPath: '/repo/apps/cli',
        readFileSyncImpl: (() => {
          throw new Error('missing package');
        }) as typeof readFileSync,
      }),
    ).toBe('0.2.8');
  });
});
