import { describe, expect, it } from 'vitest';

import { buildScpCommand, buildSshCommand, redactSshText } from './index.js';

describe('buildSshCommand', () => {
  it('builds a strict ssh command that isolates host-key state and supports keyfile auth', () => {
    const invocation = buildSshCommand({
      target: 'dev@example.test',
      port: 2222,
      auth: {
        kind: 'keyfile',
        identityFile: '/tmp/id_happier',
      },
      knownHosts: {
        mode: 'app',
        path: '/tmp/known_hosts',
      },
      remoteCommand: 'echo ok',
      connectTimeoutSeconds: 12,
    });

    expect(invocation.command).toBe('ssh');
    expect(invocation.args).toEqual([
      '-p',
      '2222',
      '-o',
      'BatchMode=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ConnectTimeout=12',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'UserKnownHostsFile=/tmp/known_hosts',
      '-o',
      'StrictHostKeyChecking=yes',
      '-i',
      '/tmp/id_happier',
      'dev@example.test',
      'bash',
      '-lc',
      '\'echo ok\'',
    ]);
  });

  it('keeps strict host-key checking enabled when using system known_hosts', () => {
    const invocation = buildSshCommand({
      target: 'dev@example.test',
      auth: {
        kind: 'agent',
      },
      knownHosts: {
        mode: 'system',
      },
      remoteCommand: 'echo ok',
    });

    expect(invocation.args).toContain('StrictHostKeyChecking=yes');
    expect(invocation.args.some((arg) => arg.startsWith('UserKnownHostsFile='))).toBe(false);
    expect(invocation.args).not.toContain('GlobalKnownHostsFile=/dev/null');
  });

  it.each([
    '-oProxyCommand=sh -c id',
    'dev@example.test\n-oProxyCommand=sh -c id',
    'dev\u0000@example.test',
  ])('rejects an unsafe target in system known_hosts mode: %j', (target) => {
    expect(() => buildSshCommand({
      target,
      auth: { kind: 'agent' },
      knownHosts: { mode: 'system' },
      remoteCommand: 'echo ok',
    })).toThrow(/ssh target/i);
  });

  it.each([0, -1, 65_536, 22.5])('rejects an invalid port: %j', (port) => {
    expect(() => buildSshCommand({
      target: 'dev@example.test',
      port,
      auth: { kind: 'agent' },
      knownHosts: { mode: 'system' },
      remoteCommand: 'echo ok',
    })).toThrow(/ssh port/i);
  });
});

describe('buildScpCommand', () => {
  it('builds a strict scp command that mirrors the ssh transport auth and host-key isolation', () => {
    const invocation = buildScpCommand({
      target: 'dev@example.test',
      remotePath: '$HOME/.happier/bootstrap-staging',
      localPath: '/tmp/payload',
      port: 2222,
      auth: {
        kind: 'keyfile',
        identityFile: '/tmp/id_happier',
      },
      knownHosts: {
        mode: 'app',
        path: '/tmp/known_hosts',
      },
      connectTimeoutSeconds: 12,
    });

    expect(invocation.command).toBe('scp');
    expect(invocation.args).toEqual([
      '-P',
      '2222',
      '-o',
      'BatchMode=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ConnectTimeout=12',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'UserKnownHostsFile=/tmp/known_hosts',
      '-o',
      'StrictHostKeyChecking=yes',
      '-i',
      '/tmp/id_happier',
      '-r',
      '/tmp/payload',
      'dev@example.test:$HOME/.happier/bootstrap-staging',
    ]);
  });

  it('keeps strict host-key checking enabled for scp when using system known_hosts', () => {
    const invocation = buildScpCommand({
      target: 'dev@example.test',
      remotePath: '$HOME/.happier/bootstrap-staging',
      localPath: '/tmp/payload',
      auth: {
        kind: 'agent',
      },
      knownHosts: {
        mode: 'system',
      },
    });

    expect(invocation.args).toContain('StrictHostKeyChecking=yes');
    expect(invocation.args.some((arg) => arg.startsWith('UserKnownHostsFile='))).toBe(false);
    expect(invocation.args).not.toContain('GlobalKnownHostsFile=/dev/null');
  });

  it('rejects ProxyCommand option injection when system known_hosts is selected', () => {
    expect(() => buildScpCommand({
      target: '-oProxyCommand=sh -c id',
      remotePath: '$HOME/.happier/bootstrap-staging',
      localPath: '/tmp/payload',
      auth: { kind: 'agent' },
      knownHosts: { mode: 'system' },
    })).toThrow(/ssh target/i);
  });
});

describe('redactSshText', () => {
  it('removes private key paths and password fragments from surfaced text', () => {
    const redacted = redactSshText(
      'Identity file /Users/me/.ssh/id_ed25519 not accessible. password: hunter2',
    );

    expect(redacted).not.toContain('/Users/me/.ssh/id_ed25519');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('[redacted-path]');
    expect(redacted).toContain('[redacted-secret]');
  });
});
