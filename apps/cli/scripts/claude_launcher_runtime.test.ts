import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canonicalHomePathRuntime = require('@happier-dev/cli-common/expandHomeDirPath') as {
  expandHomeDirPath(
    value: string,
    processEnv?: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
  ): string;
};
const launcherRuntime = require('../scripts/claude_launcher_runtime.cjs') as {
  expandHomeDirPath: typeof canonicalHomePathRuntime.expandHomeDirPath;
  getClaudeCliPath(): string;
};
const { getClaudeCliPath } = launcherRuntime;

describe('claude_launcher_runtime home expansion parity', () => {
  it('delegates to the bundled cli-common implementation body', () => {
    expect(launcherRuntime.expandHomeDirPath).toBe(canonicalHomePathRuntime.expandHomeDirPath);
  });

  it.each([
    {
      platform: 'linux' as const,
      env: { HOME: '/Users/alice' },
      cases: [
        ['~', '/Users/alice'],
        ['~/projects/repo', '/Users/alice/projects/repo'],
        ['~\\projects\\repo', '/Users/alice/projects/repo'],
        ['~/projects\\mixed/repo', '/Users/alice/projects/mixed/repo'],
        ['~alice/projects/repo', '~alice/projects/repo'],
        ['/Users/alice2/projects/repo', '/Users/alice2/projects/repo'],
      ],
    },
    {
      platform: 'win32' as const,
      env: { USERPROFILE: 'C:\\Users\\alice', HOME: 'C:\\fallback' },
      cases: [
        ['~', 'C:\\Users\\alice'],
        ['~/projects/repo', 'C:\\Users\\alice\\projects\\repo'],
        ['~\\projects\\repo', 'C:\\Users\\alice\\projects\\repo'],
        ['~/projects\\mixed/repo', 'C:\\Users\\alice\\projects\\mixed\\repo'],
        ['~alice\\projects\\repo', '~alice\\projects\\repo'],
        ['C:\\Users\\alice2\\projects\\repo', 'C:\\Users\\alice2\\projects\\repo'],
      ],
    },
  ])(
    'matches the canonical $platform separator and sibling-prefix contract',
    ({ platform, env, cases }) => {
      for (const [input, expected] of cases) {
        expect(launcherRuntime.expandHomeDirPath(input, env, platform)).toBe(expected);
      }
    },
  );
});

describe('claude_launcher_runtime getClaudeCliPath', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it('returns claude when no override is set', () => {
    delete process.env.HAPPIER_CLAUDE_PATH;
    delete process.env.HAPPY_CLAUDE_PATH;
    delete process.env.DEBUG;
    delete process.env.HAPPIER_DEBUG_CLAUDE_LAUNCHER;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getClaudeCliPath()).toBe('claude');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('expands ~/ in HAPPIER_CLAUDE_PATH', () => {
    const homeDir = fs.mkdtempSync('/tmp/happier-claude-home-');
    const localBinDir = `${homeDir}/.local/bin`;
    fs.mkdirSync(localBinDir, { recursive: true });
    const homeClaudePath = `${localBinDir}/claude`;
    fs.writeFileSync(homeClaudePath, '#!/bin/bash\necho "mock"');
    fs.chmodSync(homeClaudePath, 0o755);
    const previousHome = process.env.HOME;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      process.env.HOME = homeDir;
      process.env.HAPPIER_CLAUDE_PATH = '~/.local/bin/claude';
      delete process.env.DEBUG;
      delete process.env.HAPPIER_DEBUG_CLAUDE_LAUNCHER;

      expect(fs.realpathSync(getClaudeCliPath())).toBe(fs.realpathSync(homeClaudePath));
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('exits when the override points to a missing file', () => {
    process.env.HAPPIER_CLAUDE_PATH = '/nonexistent/path/claude';

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    expect(() => getClaudeCliPath()).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it('logs the resolved source when debug is enabled', () => {
    process.env.HAPPIER_CLAUDE_PATH = 'claude';
    process.env.DEBUG = '1';

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getClaudeCliPath()).toBe('claude');
    expect(errSpy).toHaveBeenCalled();
  });
});
