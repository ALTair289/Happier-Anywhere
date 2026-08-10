import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDeploymentKitBootstrapFiles,
  renderDeploymentKitBootstrap,
} from '../pipeline/deployment-kit/lib/deployment-kit-bootstrap.mjs';

const FORBIDDEN_NETWORK_OR_SERVICE_OWNERS = [
  /tailscale/i,
  /funnel/i,
  /netsh/i,
  /firewall/i,
  /iptables/i,
  /\bufw\b/i,
  /systemctl/i,
  /launchctl/i,
  /schtasks/i,
  /new-service/i,
  /\/etc\/systemd/i,
  /\.plist\b/i,
];

function assertDoesNotOwnNetworkOrServiceDefinition(source) {
  for (const pattern of FORBIDDEN_NETWORK_OR_SERVICE_OWNERS) {
    assert.doesNotMatch(source, pattern);
  }
}

test('createDeploymentKitBootstrapFiles emits deterministic controller, local-agent, and ssh-agent scripts for both shells', () => {
  const files = createDeploymentKitBootstrapFiles();

  assert.deepEqual(
    files.map(({ path, role, shell, mode }) => ({ path, role, shell, mode })),
    [
      { path: 'bootstrap/agent.ps1', role: 'agent', shell: 'powershell', mode: 0o644 },
      { path: 'bootstrap/agent.sh', role: 'agent', shell: 'posix', mode: 0o755 },
      { path: 'bootstrap/controller.ps1', role: 'controller', shell: 'powershell', mode: 0o644 },
      { path: 'bootstrap/controller.sh', role: 'controller', shell: 'posix', mode: 0o755 },
      { path: 'bootstrap/ssh-agent.ps1', role: 'ssh-agent', shell: 'powershell', mode: 0o644 },
      { path: 'bootstrap/ssh-agent.sh', role: 'ssh-agent', shell: 'posix', mode: 0o755 },
    ],
  );
  assert.equal(new Set(files.map((entry) => entry.path)).size, 6);
  for (const file of files) {
    assert.equal(file.contents.endsWith('\n'), true);
    assert.equal(file.contents, renderDeploymentKitBootstrap({ role: file.role, shell: file.shell }));
  }
});

test('ssh-agent bootstraps pass the verified offline payload to canonical machine setup', () => {
  const powershell = renderDeploymentKitBootstrap({ role: 'ssh-agent', shell: 'powershell' });
  const posix = renderDeploymentKitBootstrap({ role: 'ssh-agent', shell: 'posix' });

  assert.match(powershell, /Resolve-VerifiedPayloadDirectory -Path \$CliPayload/);
  assert.match(powershell, /'machine', 'setup', '--ssh', \$sshTargetValue/);
  assert.match(powershell, /'--cli-payload', \$cliPayloadPath/);
  assert.match(powershell, /'--server-url', \$relayUrlValue, '--webapp-url', \$webappUrlValue/);
  assert.match(powershell, /if \(\$Yes\.IsPresent\).*'--yes'/s);
  assert.equal((powershell.match(/& \$happierPath /g) ?? []).length, 1);

  assert.match(posix, /require_directory "\$cli_payload" "CLI payload"/);
  assert.match(
    posix,
    /"\$happier_binary" machine setup --ssh "\$ssh_target" --cli-payload "\$cli_payload" --server-url "\$relay_url" --webapp-url "\$webapp_url"/,
  );
  assert.match(posix, /--yes/);
  assert.equal((posix.match(/run_happier .*"\$happier_binary" /g) ?? []).length, 2);

  for (const source of [powershell, posix]) {
    assert.doesNotMatch(source, /--token|--password|--secret/i);
    assertDoesNotOwnNetworkOrServiceDefinition(source);
  }
});

test('controller bootstraps validate local files and delegate only to loopback relay host install', () => {
  const powershell = renderDeploymentKitBootstrap({ role: 'controller', shell: 'powershell' });
  const posix = renderDeploymentKitBootstrap({ role: 'controller', shell: 'posix' });

  assert.match(powershell, /Get-Item -LiteralPath \$Path -Force -ErrorAction Stop/);
  assert.match(powershell, /FileAttributes\]::ReparsePoint/);
  assert.match(powershell, /HAPPIER_BOOTSTRAP_RELAY_PORT/);
  assert.doesNotMatch(powershell, /\$relayPortRaw/);
  assert.match(
    powershell,
    /& \$happierPath relay host install --server-binary \$serverBinaryPath --host '127\.0\.0\.1' --mode user --yes --json --env 'PORT=3005'/,
  );
  assert.equal((powershell.match(/& \$happierPath /g) ?? []).length, 1);

  assert.match(posix, /\[ -f "\$candidate" \]/);
  assert.match(posix, /\[ ! -L "\$candidate" \]/);
  assert.match(posix, /HAPPIER_BOOTSTRAP_RELAY_PORT/);
  assert.doesNotMatch(posix, /relay_port=/);
  assert.match(
    posix,
    /"\$happier_binary" relay host install --server-binary "\$server_binary" --host 127\.0\.0\.1 --mode user --yes --json --env PORT=3005/,
  );
  assert.equal((posix.match(/run_happier .*"\$happier_binary" /g) ?? []).length, 1);

  assertDoesNotOwnNetworkOrServiceDefinition(powershell);
  assertDoesNotOwnNetworkOrServiceDefinition(posix);
});

test('agent bootstraps require HTTPS and delegate profile, authentication, and service lifecycle to Happier', () => {
  const powershell = renderDeploymentKitBootstrap({ role: 'agent', shell: 'powershell' });
  const posix = renderDeploymentKitBootstrap({ role: 'agent', shell: 'posix' });

  assert.match(powershell, /\$uri\.Scheme -cne 'https'/);
  assert.match(powershell, /\$uri\.UserInfo/);
  assert.match(powershell, /FileAttributes\]::ReparsePoint/);
  assert.match(powershell, /& \$happierPath server set --server-url \$relayUrlValue --webapp-url \$webappUrlValue --json/);
  assert.match(powershell, /& \$happierPath auth login --no-open --server-url \$relayUrlValue --webapp-url \$webappUrlValue --persist/);
  assert.match(powershell, /& \$happierPath service install --mode user --yes --json/);
  assert.equal((powershell.match(/& \$happierPath /g) ?? []).length, 3);

  assert.match(posix, /https:\/\/\?\*/);
  assert.match(posix, /\*'@'\*/);
  assert.match(posix, /webapp_url=\$relay_url/);
  assert.match(posix, /\[ ! -L "\$candidate" \]/);
  assert.match(posix, /"\$happier_binary" server set --server-url "\$relay_url" --webapp-url "\$webapp_url" --json/);
  assert.match(posix, /"\$happier_binary" auth login --no-open --server-url "\$relay_url" --webapp-url "\$webapp_url" --persist/);
  assert.match(posix, /"\$happier_binary" service install --mode user --yes --json/);
  assert.equal((posix.match(/run_happier .*"\$happier_binary" /g) ?? []).length, 3);

  for (const source of [powershell, posix]) {
    assert.doesNotMatch(source, /--token|--password|--secret/i);
    assertDoesNotOwnNetworkOrServiceDefinition(source);
  }
});

test('renderDeploymentKitBootstrap fails closed for unknown role or shell', () => {
  assert.throws(
    () => renderDeploymentKitBootstrap({ role: 'bridge', shell: 'posix' }),
    /unsupported bootstrap role/i,
  );
  assert.throws(
    () => renderDeploymentKitBootstrap({ role: 'agent', shell: 'cmd' }),
    /unsupported bootstrap shell/i,
  );
});

test('generated PowerShell bootstraps parse on Windows PowerShell 5.1+', (t) => {
  const parserCommand = [
    '$source = [Console]::In.ReadToEnd()',
    '$tokens = $null',
    '$errors = $null',
    '[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null',
    'if ($errors.Count -ne 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }',
  ].join('; ');

  for (const role of ['controller', 'agent', 'ssh-agent']) {
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parserCommand],
      {
        encoding: 'utf8',
        input: renderDeploymentKitBootstrap({ role, shell: 'powershell' }),
        windowsHide: true,
      },
    );
    if (result.error?.code === 'ENOENT') {
      t.skip('Windows PowerShell is unavailable on this host');
      return;
    }
    assert.equal(result.status, 0, result.stderr || `${role} PowerShell parser failed`);
  }
});

test('PowerShell controller bootstrap uses fixed port 3005 and rejects an ambient override', async (t) => {
  const probe = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    windowsHide: true,
  });
  if (probe.error?.code === 'ENOENT') {
    t.skip('Windows PowerShell is unavailable on this host');
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-bootstrap-powershell-'));
  t.after(async () => await rm(tempRoot, { recursive: true, force: true }));
  const fakeHappier = join(tempRoot, 'happier.cmd');
  const relayServer = join(tempRoot, 'happier-server.cmd');
  const callsPath = join(tempRoot, 'calls.txt');
  await writeFile(fakeHappier, '@echo off\r\necho %*>>"%HAPPIER_TEST_CALLS%"\r\nexit /b 0\r\n');
  await writeFile(relayServer, '@echo off\r\nexit /b 0\r\n');

  const controllerSource = renderDeploymentKitBootstrap({ role: 'controller', shell: 'powershell' });
  const inMemoryRunner = [
    '$source = [Console]::In.ReadToEnd()',
    '$bootstrap = [ScriptBlock]::Create($source)',
    '& $bootstrap -HappierBinary $env:HAPPIER_TEST_BINARY -ServerBinary $env:HAPPIER_TEST_SERVER_BINARY',
  ].join('; ');
  const baseEnv = {
    ...process.env,
    HAPPIER_TEST_BINARY: fakeHappier,
    HAPPIER_TEST_SERVER_BINARY: relayServer,
    HAPPIER_TEST_CALLS: callsPath,
  };
  delete baseEnv.HAPPIER_BOOTSTRAP_RELAY_PORT;
  const success = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inMemoryRunner],
    { encoding: 'utf8', env: baseEnv, input: controllerSource, windowsHide: true },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.match(
    (await readFile(callsPath, 'utf8')).trim(),
    /relay host install .* --host 127\.0\.0\.1 --mode user --yes --json --env PORT=3005$/,
  );

  await writeFile(callsPath, '', 'utf8');
  const ambientOverride = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inMemoryRunner],
    {
      encoding: 'utf8',
      env: { ...baseEnv, HAPPIER_BOOTSTRAP_RELAY_PORT: '43117' },
      input: controllerSource,
      windowsHide: true,
    },
  );
  assert.notEqual(ambientOverride.status, 0);
  assert.equal(await readFile(callsPath, 'utf8'), '');
});

test('PowerShell ssh-agent bootstrap invokes canonical machine setup with the verified payload', async (t) => {
  const probe = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    windowsHide: true,
  });
  if (probe.error?.code === 'ENOENT') {
    t.skip('Windows PowerShell is unavailable on this host');
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-ssh-agent-powershell-'));
  t.after(async () => await rm(tempRoot, { recursive: true, force: true }));
  const fakeHappier = join(tempRoot, 'happier.cmd');
  const payloadRoot = join(tempRoot, 'linux-agent-payload');
  const callsPath = join(tempRoot, 'calls.txt');
  await writeFile(fakeHappier, '@echo off\r\necho %*>>"%HAPPIER_TEST_CALLS%"\r\nexit /b 0\r\n');
  await writeFile(callsPath, '', 'utf8');
  await mkdir(payloadRoot);

  const source = renderDeploymentKitBootstrap({ role: 'ssh-agent', shell: 'powershell' });
  const inMemoryRunner = [
    '$source = [Console]::In.ReadToEnd()',
    '$bootstrap = [ScriptBlock]::Create($source)',
    '& $bootstrap -HappierBinary $env:HAPPIER_TEST_BINARY -SshTarget "agent@example.test" -CliPayload $env:HAPPIER_TEST_PAYLOAD -ServerUrl "https://relay.example.test" -WebappUrl "https://app.example.test" -Yes',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inMemoryRunner],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HAPPIER_TEST_BINARY: fakeHappier,
        HAPPIER_TEST_PAYLOAD: payloadRoot,
        HAPPIER_TEST_CALLS: callsPath,
      },
      input: source,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const call = (await readFile(callsPath, 'utf8')).trim();
  assert.match(call, /^machine setup --ssh agent@example\.test --cli-payload /);
  assert.match(call, / --server-url https:\/\/relay\.example\.test --webapp-url https:\/\/app\.example\.test --yes$/);
});

test('generated POSIX bootstraps pass sh syntax validation', (t) => {
  for (const role of ['controller', 'agent', 'ssh-agent']) {
    const result = spawnSync('sh', ['-n'], {
      encoding: 'utf8',
      input: renderDeploymentKitBootstrap({ role, shell: 'posix' }),
      windowsHide: true,
    });
    if (result.error?.code === 'ENOENT') {
      t.skip('POSIX sh is unavailable on this host');
      return;
    }
    assert.equal(result.status, 0, result.stderr || `${role} POSIX parser failed`);
  }
});

function toPosixShellPath(path) {
  if (process.platform !== 'win32') return path;
  const match = /^([A-Za-z]):\\(.*)$/.exec(path);
  if (!match) return path.replaceAll('\\', '/');
  return `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

test('POSIX bootstraps fail closed before invoking Happier and preserve the canonical argv', async (t) => {
  const shellProbe = spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true });
  if (shellProbe.error?.code === 'ENOENT') {
    t.skip('POSIX sh is unavailable on this host');
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-bootstrap-'));
  t.after(async () => await rm(tempRoot, { recursive: true, force: true }));
  const fakeHappier = join(tempRoot, 'happier');
  const relayServer = join(tempRoot, 'happier-server');
  const controllerScript = join(tempRoot, 'controller.sh');
  const agentScript = join(tempRoot, 'agent.sh');
  const sshAgentScript = join(tempRoot, 'ssh-agent.sh');
  const cliPayloadRoot = join(tempRoot, 'linux-agent-payload');
  const callsPath = join(tempRoot, 'calls.txt');
  await writeFile(fakeHappier, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$HAPPIER_TEST_CALLS"\n', { mode: 0o755 });
  await writeFile(relayServer, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(controllerScript, renderDeploymentKitBootstrap({ role: 'controller', shell: 'posix' }), { mode: 0o755 });
  await writeFile(agentScript, renderDeploymentKitBootstrap({ role: 'agent', shell: 'posix' }), { mode: 0o755 });
  await writeFile(sshAgentScript, renderDeploymentKitBootstrap({ role: 'ssh-agent', shell: 'posix' }), { mode: 0o755 });
  await mkdir(cliPayloadRoot);
  await Promise.all([fakeHappier, relayServer, controllerScript, agentScript, sshAgentScript].map(async (path) => await chmod(path, 0o755)));

  const shellFakeHappier = toPosixShellPath(fakeHappier);
  const shellRelayServer = toPosixShellPath(relayServer);
  const shellCliPayloadRoot = toPosixShellPath(cliPayloadRoot);
  const sharedEnv = {
    ...process.env,
    HAPPIER_TEST_CALLS: toPosixShellPath(callsPath),
  };
  delete sharedEnv.HAPPIER_BOOTSTRAP_RELAY_PORT;
  const controllerResult = spawnSync(
    'sh',
    [toPosixShellPath(controllerScript), shellFakeHappier, shellRelayServer],
    { encoding: 'utf8', env: sharedEnv, windowsHide: true },
  );
  assert.equal(controllerResult.status, 0, controllerResult.stderr);
  assert.equal(
    (await readFile(callsPath, 'utf8')).trim(),
    `relay host install --server-binary ${shellRelayServer} --host 127.0.0.1 --mode user --yes --json --env PORT=3005`,
  );

  await writeFile(callsPath, '', 'utf8');
  const ambientPortResult = spawnSync(
    'sh',
    [toPosixShellPath(controllerScript), shellFakeHappier, shellRelayServer],
    {
      encoding: 'utf8',
      env: { ...sharedEnv, HAPPIER_BOOTSTRAP_RELAY_PORT: '43117' },
      windowsHide: true,
    },
  );
  assert.notEqual(ambientPortResult.status, 0);
  assert.equal(await readFile(callsPath, 'utf8'), '');

  const missingPathResult = spawnSync(
    'sh',
    [toPosixShellPath(controllerScript), `${shellFakeHappier}.missing`, shellRelayServer],
    { encoding: 'utf8', env: sharedEnv, windowsHide: true },
  );
  assert.notEqual(missingPathResult.status, 0);
  assert.equal(await readFile(callsPath, 'utf8'), '');

  const symlinkPath = join(tempRoot, 'happier-link');
  try {
    await symlink(fakeHappier, symlinkPath, 'file');
    const symlinkResult = spawnSync(
      'sh',
      [toPosixShellPath(controllerScript), toPosixShellPath(symlinkPath), shellRelayServer],
      { encoding: 'utf8', env: sharedEnv, windowsHide: true },
    );
    assert.notEqual(symlinkResult.status, 0);
    assert.equal(await readFile(callsPath, 'utf8'), '');
  } catch (error) {
    if (!['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
    t.diagnostic(`symbolic-link runtime case skipped by host: ${error.code}`);
  }

  const agentResult = spawnSync(
    'sh',
    [toPosixShellPath(agentScript), shellFakeHappier, 'https://relay.example.test', 'https://app.example.test'],
    { encoding: 'utf8', env: sharedEnv, windowsHide: true },
  );
  assert.equal(agentResult.status, 0, agentResult.stderr);
  assert.deepEqual((await readFile(callsPath, 'utf8')).trim().split('\n'), [
    'server set --server-url https://relay.example.test --webapp-url https://app.example.test --json',
    'auth login --no-open --server-url https://relay.example.test --webapp-url https://app.example.test --persist',
    'service install --mode user --yes --json',
  ]);

  await writeFile(callsPath, '', 'utf8');
  const httpResult = spawnSync(
    'sh',
    [toPosixShellPath(agentScript), shellFakeHappier, 'http://relay.example.test'],
    { encoding: 'utf8', env: sharedEnv, windowsHide: true },
  );
  assert.notEqual(httpResult.status, 0);
  assert.equal(await readFile(callsPath, 'utf8'), '');

  const sshAgentResult = spawnSync(
    'sh',
    [
      toPosixShellPath(sshAgentScript),
      shellFakeHappier,
      'agent@example.test',
      shellCliPayloadRoot,
      'https://relay.example.test',
      'https://app.example.test',
      '--yes',
    ],
    { encoding: 'utf8', env: sharedEnv, windowsHide: true },
  );
  assert.equal(sshAgentResult.status, 0, sshAgentResult.stderr);
  assert.equal(
    (await readFile(callsPath, 'utf8')).trim(),
    `machine setup --ssh agent@example.test --cli-payload ${shellCliPayloadRoot} --server-url https://relay.example.test --webapp-url https://app.example.test --yes`,
  );

  await writeFile(callsPath, '', 'utf8');
  const missingPayloadResult = spawnSync(
    'sh',
    [
      toPosixShellPath(sshAgentScript),
      shellFakeHappier,
      'agent@example.test',
      `${shellCliPayloadRoot}.missing`,
      'https://relay.example.test',
    ],
    { encoding: 'utf8', env: sharedEnv, windowsHide: true },
  );
  assert.notEqual(missingPayloadResult.status, 0);
  assert.equal(await readFile(callsPath, 'utf8'), '');
});
