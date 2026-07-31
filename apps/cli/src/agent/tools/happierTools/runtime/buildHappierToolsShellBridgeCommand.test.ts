import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const ENV_KEYS = [
  'HAPPIER_SHELL_BRIDGE_CONTEXT_ENV',
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_ACCESS_TOKEN',
] as const;

let envScope = createEnvKeyScope(ENV_KEYS);
const tempDirs = new Set<string>();

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(ENV_KEYS);
  for (const dir of tempDirs) removeTempDirSync(dir);
  tempDirs.clear();
  vi.resetModules();
});

describe('buildHappierToolsShellBridgeCommand', () => {
  it('recognizes only the exact locally generated bridge launcher as trusted', async () => {
    const {
      buildHappierToolsShellBridgeCommand,
      parseTrustedHappierToolsShellBridgeCommand,
    } = await import('./buildHappierToolsShellBridgeCommand');
    const command = buildHappierToolsShellBridgeCommand([
      'call',
      '--source',
      'happier',
      '--tool',
      'save_memory',
      '--args-json',
      '{"memory":"remember this"}',
      '--json',
    ]);

    expect(parseTrustedHappierToolsShellBridgeCommand(command)).toMatchObject({
      kind: 'call',
      source: 'happier',
      tool: 'save_memory',
      args: { memory: 'remember this' },
    });
    expect(
      parseTrustedHappierToolsShellBridgeCommand(
        `happier tools call --source happier --tool save_memory --args-json '{"memory":"remember this"}' --json`,
      ),
    ).toBeNull();
    expect(
      parseTrustedHappierToolsShellBridgeCommand(
        `node ./happier-helper.js tools call --source happier --tool save_memory --args-json '{"memory":"remember this"}' --json`,
      ),
    ).toBeNull();
    expect(parseTrustedHappierToolsShellBridgeCommand(`${command} && touch /tmp/happier-pwn`)).toBeNull();
  });

  it('rejects a modified environment prelude even when the bridge suffix is canonical', async () => {
    const happierHome = createTempDirSync('happier-tools-shell-bridge-home-');
    tempDirs.add(happierHome);
    envScope.patch({
      HAPPIER_SHELL_BRIDGE_CONTEXT_ENV: 'home',
      HAPPIER_HOME_DIR: happierHome,
    });
    vi.resetModules();

    const {
      buildHappierToolsShellBridgeCommand,
      parseTrustedHappierToolsShellBridgeCommand,
    } = await import('./buildHappierToolsShellBridgeCommand');
    const command = buildHappierToolsShellBridgeCommand(['list', '--json']);

    expect(parseTrustedHappierToolsShellBridgeCommand(command)).toMatchObject({ kind: 'list' });
    expect(
      parseTrustedHappierToolsShellBridgeCommand(
        command.replace(`HAPPIER_HOME_DIR='${happierHome}'`, `HAPPIER_HOME_DIR='/tmp/attacker'`),
      ),
    ).toBeNull();
  });

  it('does not inline Happier runtime context by default', async () => {
    const happierHome = createTempDirSync('happier-tools-shell-bridge-home-');
    tempDirs.add(happierHome);
    envScope.patch({
      HAPPIER_HOME_DIR: happierHome,
      HAPPIER_ACTIVE_SERVER_ID: 'preview',
      HAPPIER_SERVER_URL: 'https://preview.happier.example',
      HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:48999',
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.happier.example',
      HAPPIER_WEBAPP_URL: 'https://app.happier.example',
      HAPPIER_ACCESS_TOKEN: 'secret-token-that-must-not-be-embedded',
    });
    vi.resetModules();

    const { buildHappierToolsShellBridgeCommand } = await import('./buildHappierToolsShellBridgeCommand');

    const command = buildHappierToolsShellBridgeCommand([
      'call',
      '--source',
      'happier',
      '--tool',
      'change_title',
      '--args-json',
      '{"title":"Renamed"}',
      '--json',
    ]);

    expect(command).not.toContain('HAPPIER_HOME_DIR=');
    expect(command).not.toContain('HAPPIER_SERVER_URL=');
    // Binary-safe invocation of the tools CLI.
    expect(command).toContain("'tools' 'call'");
    expect(command).toContain("'--tool' 'change_title'");
    // Never embed credentials.
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });

  it('inlines only Happier home when explicitly configured for home context', async () => {
    const happierHome = createTempDirSync('happier-tools-shell-bridge-home-');
    tempDirs.add(happierHome);
    envScope.patch({
      HAPPIER_SHELL_BRIDGE_CONTEXT_ENV: 'home',
      HAPPIER_HOME_DIR: happierHome,
      HAPPIER_ACTIVE_SERVER_ID: 'preview',
      HAPPIER_SERVER_URL: 'https://preview.happier.example',
      HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:48999',
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.happier.example',
      HAPPIER_WEBAPP_URL: 'https://app.happier.example',
      HAPPIER_ACCESS_TOKEN: 'secret-token-that-must-not-be-embedded',
    });
    vi.resetModules();

    const { buildHappierToolsShellBridgeCommand } = await import('./buildHappierToolsShellBridgeCommand');

    const command = buildHappierToolsShellBridgeCommand(['list', '--json']);

    expect(command).toContain(`HAPPIER_HOME_DIR='${happierHome}'`);
    expect(command).not.toContain('HAPPIER_ACTIVE_SERVER_ID=');
    expect(command).not.toContain('HAPPIER_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_LOCAL_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_PUBLIC_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_WEBAPP_URL=');
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });

  it('inlines full Happier runtime context when explicitly configured for full context', async () => {
    const happierHome = createTempDirSync('happier-tools-shell-bridge-home-');
    tempDirs.add(happierHome);
    envScope.patch({
      HAPPIER_SHELL_BRIDGE_CONTEXT_ENV: 'full',
      HAPPIER_HOME_DIR: happierHome,
      HAPPIER_ACTIVE_SERVER_ID: 'preview',
      HAPPIER_SERVER_URL: 'https://preview.happier.example',
      HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:48999',
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.happier.example',
      HAPPIER_WEBAPP_URL: 'https://app.happier.example',
      HAPPIER_ACCESS_TOKEN: 'secret-token-that-must-not-be-embedded',
    });
    vi.resetModules();

    const { buildHappierToolsShellBridgeCommand } = await import('./buildHappierToolsShellBridgeCommand');

    const command = buildHappierToolsShellBridgeCommand(['list', '--json']);

    expect(command).toContain(`HAPPIER_HOME_DIR='${happierHome}'`);
    expect(command).toContain("HAPPIER_ACTIVE_SERVER_ID='preview'");
    expect(command).toContain("HAPPIER_SERVER_URL='http://127.0.0.1:48999'");
    expect(command).toContain("HAPPIER_PUBLIC_SERVER_URL='https://public.happier.example'");
    expect(command).toContain("HAPPIER_WEBAPP_URL='https://app.happier.example'");
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });
});
