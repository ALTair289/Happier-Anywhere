import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, queryMock, ensureClaudeJsRuntimeExecutableMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  queryMock: vi.fn(),
  ensureClaudeJsRuntimeExecutableMock: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

vi.mock('./query', () => ({
  query: queryMock,
}));

vi.mock('@/backends/claude/utils/ensureClaudeJsRuntimeExecutable', () => ({
  ensureClaudeJsRuntimeExecutable: ensureClaudeJsRuntimeExecutableMock,
}));

function createQueryResult(params: Readonly<{
  tools?: readonly string[];
  slashCommands?: readonly string[];
}> = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'system',
        subtype: 'init',
        tools: [...(params.tools ?? ['read'])],
        slash_commands: [...(params.slashCommands ?? ['/help'])],
      };
    },
  };
}

let testRoot: string;
let originalCwd: string;
let happierHomeDir: string;
let projectDir: string;
let claudeConfigDir: string;
let claudePath: string;

async function importMetadataExtractor() {
  vi.resetModules();
  return await import('./metadataExtractor');
}

function writeConfigFingerprintFile(relativePath: string, content: string): void {
  const path = join(projectDir, ...relativePath.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

describe('extractSDKMetadata', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = mkdtempSync(join(tmpdir(), 'happier-claude-sdk-metadata-'));
    const homeDir = join(testRoot, 'home');
    happierHomeDir = join(testRoot, 'happy-home');
    projectDir = join(testRoot, 'project');
    claudeConfigDir = join(homeDir, '.claude');
    claudePath = join(testRoot, process.platform === 'win32' ? 'claude.cmd' : 'claude');

    mkdirSync(claudeConfigDir, { recursive: true });
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(join(claudeConfigDir, 'settings.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    writeFileSync(claudePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(claudePath, 0o755);

    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HAPPIER_HOME_DIR', happierHomeDir);
    vi.stubEnv('HAPPIER_CLAUDE_PATH', claudePath);
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
    process.chdir(projectDir);

    queryMock.mockReset();
    execFileSyncMock.mockReset();
    ensureClaudeJsRuntimeExecutableMock.mockReset();
    execFileSyncMock.mockReturnValue('claude 2.1.153\n');
    ensureClaudeJsRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    queryMock.mockReturnValue(createQueryResult());
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('bootstraps the managed JavaScript runtime before starting the SDK metadata query', async () => {
    const { extractSDKMetadata } = await importMetadataExtractor();

    const metadata = await extractSDKMetadata();

    expect(ensureClaudeJsRuntimeExecutableMock).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          executable: '/managed/js-runtime',
        }),
      }),
    );
    expect(metadata).toEqual({
      tools: ['read'],
      slashCommands: ['/help'],
    });
  });

  it('probes and persists metadata on the first version and config fingerprint cache miss', async () => {
    const { extractSDKMetadata } = await importMetadataExtractor();

    const metadata = await extractSDKMetadata();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(metadata).toEqual({
      tools: ['read'],
      slashCommands: ['/help'],
    });
    const cacheFile = JSON.parse(readFileSync(join(happierHomeDir, 'cli', 'claude-sdk-metadata-cache.json'), 'utf8')) as {
      version?: unknown;
      byKey?: unknown;
    };
    expect(cacheFile.version).toBe(1);
    expect(Object.keys(cacheFile.byKey as Record<string, unknown>)).toHaveLength(1);
  });

  it('reuses cached metadata for the same Claude version and config fingerprint without probing again', async () => {
    const firstModule = await importMetadataExtractor();
    const first = await firstModule.extractSDKMetadata();
    expect(queryMock).toHaveBeenCalledTimes(1);

    queryMock.mockClear();
    queryMock.mockReturnValue(createQueryResult({ tools: ['write'], slashCommands: ['/other'] }));

    const secondModule = await importMetadataExtractor();
    const second = await secondModule.extractSDKMetadata();

    expect(second).toEqual(first);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('re-probes when the Claude version changes', async () => {
    const firstModule = await importMetadataExtractor();
    await firstModule.extractSDKMetadata();
    expect(queryMock).toHaveBeenCalledTimes(1);

    execFileSyncMock.mockReturnValue('claude 2.1.154\n');
    queryMock.mockClear();
    queryMock.mockReturnValue(createQueryResult({ tools: ['write'], slashCommands: ['/new-version'] }));

    const secondModule = await importMetadataExtractor();
    const second = await secondModule.extractSDKMetadata();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual({
      tools: ['write'],
      slashCommands: ['/new-version'],
    });
  });

  it('re-probes when the Claude command config fingerprint changes', async () => {
    const firstModule = await importMetadataExtractor();
    await firstModule.extractSDKMetadata();
    expect(queryMock).toHaveBeenCalledTimes(1);

    writeConfigFingerprintFile('.claude/commands/custom.md', '# Custom command\n');
    queryMock.mockClear();
    queryMock.mockReturnValue(createQueryResult({ tools: ['read', 'write'], slashCommands: ['/custom'] }));

    const secondModule = await importMetadataExtractor();
    const second = await secondModule.extractSDKMetadata();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual({
      tools: ['read', 'write'],
      slashCommands: ['/custom'],
    });
  });

  it('re-probes when explicit cache invalidation is requested', async () => {
    const firstModule = await importMetadataExtractor();
    await firstModule.extractSDKMetadata();
    expect(queryMock).toHaveBeenCalledTimes(1);

    vi.stubEnv('HAPPIER_CLAUDE_SDK_METADATA_CACHE_INVALIDATE', '1');
    queryMock.mockClear();
    queryMock.mockReturnValue(createQueryResult({ tools: ['read', 'search'], slashCommands: ['/invalidated'] }));

    const secondModule = await importMetadataExtractor();
    const second = await secondModule.extractSDKMetadata();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual({
      tools: ['read', 'search'],
      slashCommands: ['/invalidated'],
    });
  });
});
