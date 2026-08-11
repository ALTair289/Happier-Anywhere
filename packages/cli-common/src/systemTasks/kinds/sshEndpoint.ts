import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  normalizeSystemTaskSshPort,
  normalizeSystemTaskSshTarget,
  type SystemTaskSshConnectionConfig,
} from './relayRuntimeKinds.js';

export type ResolvedSystemTaskSshEndpoint = Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  keyscanHost: string;
  knownHostsHost: string;
  assertConfigUnchanged: () => void;
  assertKeyscanSupported: () => void;
}>;

type SshConfigResolution = Readonly<{
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}>;

export type ResolveSystemTaskSshEndpointDeps = Readonly<{
  resolveSshConfig?: (params: Readonly<{
    sshConfigFile: string;
    target: string;
  }>) => SshConfigResolution;
}>;

const endpointSessions = new WeakMap<SystemTaskSshConnectionConfig, ResolvedSystemTaskSshEndpoint>();

function parseSshTarget(target: string): Readonly<{ target: string; host: string; port?: number }> {
  const raw = normalizeSystemTaskSshTarget(target);
  const userSeparatorIndex = raw.lastIndexOf('@');
  const userPrefix = userSeparatorIndex >= 0 ? raw.slice(0, userSeparatorIndex + 1) : '';
  const withoutUser = userSeparatorIndex >= 0 ? raw.slice(userSeparatorIndex + 1) : raw;
  const bracketMatch = /^\[(.+)\](?::(\d+))?$/u.exec(withoutUser);
  if (bracketMatch) {
    const host = bracketMatch[1] ?? '';
    return {
      target: `${userPrefix}[${host}]`,
      host,
      ...(bracketMatch[2] ? { port: normalizeSystemTaskSshPort(Number(bracketMatch[2])) } : {}),
    };
  }
  const colonParts = withoutUser.split(':');
  if (colonParts.length === 2 && /^\d+$/u.test(colonParts[1] ?? '')) {
    const host = colonParts[0] ?? withoutUser;
    return {
      target: `${userPrefix}${host}`,
      host,
      port: normalizeSystemTaskSshPort(Number(colonParts[1])),
    };
  }
  return { target: raw, host: withoutUser };
}

function defaultResolveSshConfig(params: Readonly<{
  sshConfigFile: string;
  target: string;
}>): SshConfigResolution {
  return spawnSync('ssh', ['-G', '-F', params.sshConfigFile, params.target], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function requireSuccessfulSshConfigResolution(result: SshConfigResolution): string {
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(stderr ? `SSH config resolution failed: ${stderr}` : 'SSH config resolution failed');
  }
  return String(result.stdout ?? '');
}

function canonicalSshConfigFingerprint(stdout: string): string {
  const canonical = String(stdout ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function parseSshConfigValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const splitIndex = trimmed.indexOf(' ');
    if (splitIndex < 0) continue;
    const key = trimmed.slice(0, splitIndex).trim().toLowerCase();
    const value = trimmed.slice(splitIndex + 1).trim();
    if (key && value) values.set(key, value);
  }
  return values;
}

function configuredValue(values: ReadonlyMap<string, string>, key: string): string | undefined {
  const value = values.get(key)?.trim();
  return value && value.toLowerCase() !== 'none' ? value : undefined;
}

function formatKnownHostsHost(host: string, port?: number): string {
  return port !== undefined && port !== 22 ? `[${host}]:${port}` : host;
}

export function bindSystemTaskSshEndpoint(
  endpoint: ResolvedSystemTaskSshEndpoint,
  ssh: SystemTaskSshConnectionConfig,
): SystemTaskSshConnectionConfig {
  endpointSessions.set(ssh, endpoint);
  return ssh;
}

export function resolveSystemTaskSshEndpoint(
  params: Readonly<{ ssh: SystemTaskSshConnectionConfig }>,
  deps: ResolveSystemTaskSshEndpointDeps = {},
): ResolvedSystemTaskSshEndpoint {
  const cached = endpointSessions.get(params.ssh);
  if (cached) return cached;

  const parsedTarget = parseSshTarget(params.ssh.target);
  const explicitPort = normalizeSystemTaskSshPort(params.ssh.port);
  const sshConfigFile = String(params.ssh.sshConfigFile ?? '').trim();
  const { port: _inputPort, sshConfigFile: _inputSshConfigFile, ...sshWithoutEndpoint } = params.ssh;
  const buildEndpoint = (config: Readonly<{
    keyscanHost: string;
    knownHostsHost: string;
    port?: number;
    assertConfigUnchanged: () => void;
    assertKeyscanSupported: () => void;
  }>): ResolvedSystemTaskSshEndpoint => {
    const endpoint: ResolvedSystemTaskSshEndpoint = {
      ssh: {
      ...sshWithoutEndpoint,
      target: parsedTarget.target,
      ...(sshConfigFile ? { sshConfigFile } : {}),
        ...(config.port !== undefined ? { port: config.port } : {}),
      },
      keyscanHost: normalizeSystemTaskSshTarget(config.keyscanHost),
      knownHostsHost: normalizeSystemTaskSshTarget(config.knownHostsHost),
      assertConfigUnchanged: config.assertConfigUnchanged,
      assertKeyscanSupported: config.assertKeyscanSupported,
    };
    endpointSessions.set(params.ssh, endpoint);
    endpointSessions.set(endpoint.ssh, endpoint);
    return endpoint;
  };

  if (!sshConfigFile) {
    const port = explicitPort ?? parsedTarget.port;
    return buildEndpoint({
      keyscanHost: parsedTarget.host,
      knownHostsHost: formatKnownHostsHost(parsedTarget.host, port),
      ...(port !== undefined ? { port } : {}),
      assertConfigUnchanged: () => undefined,
      assertKeyscanSupported: () => undefined,
    });
  }

  const resolveSshConfig = deps.resolveSshConfig ?? defaultResolveSshConfig;
  const resolutionParams = {
    sshConfigFile,
    target: parsedTarget.target,
  };
  const stdout = requireSuccessfulSshConfigResolution(resolveSshConfig(resolutionParams));
  const fingerprint = canonicalSshConfigFingerprint(stdout);
  const values = parseSshConfigValues(stdout);

  const configuredPortRaw = values.get('port');
  const configuredPort = configuredPortRaw === undefined
    ? undefined
    : normalizeSystemTaskSshPort(Number(configuredPortRaw));
  const port = explicitPort ?? parsedTarget.port ?? configuredPort;
  const keyscanHost = values.get('hostname')?.trim() || parsedTarget.host;
  const hostKeyAlias = configuredValue(values, 'hostkeyalias');
  const proxyJump = configuredValue(values, 'proxyjump');
  const proxyCommand = configuredValue(values, 'proxycommand');
  return buildEndpoint({
    keyscanHost,
    knownHostsHost: formatKnownHostsHost(hostKeyAlias ?? keyscanHost, port),
    ...(port !== undefined ? { port } : {}),
    assertConfigUnchanged: () => {
      const currentStdout = requireSuccessfulSshConfigResolution(resolveSshConfig(resolutionParams));
      if (canonicalSshConfigFingerprint(currentStdout) !== fingerprint) {
        throw new Error('SSH config changed during the active task; refusing to start SSH transport.');
      }
    },
    assertKeyscanSupported: () => {
      if (proxyJump || proxyCommand) {
        throw new Error('SSH host-key scanning cannot safely reproduce ProxyJump or ProxyCommand; refusing direct keyscan.');
      }
    },
  });
}
