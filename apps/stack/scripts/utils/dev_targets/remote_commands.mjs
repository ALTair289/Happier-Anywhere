function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function wrapRemoteScript(target, script) {
  if (target.platform === 'windows') {
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
  }
  return `bash -lc ${posixQuote(script)}`;
}

export function buildRemoteEnsureDirectoriesCommand(target) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(target.repoDir)} | Out-Null`,
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(target.cliHomeDir)} | Out-Null`,
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    `set -euo pipefail; mkdir -p -- ${posixQuote(target.repoDir)} ${posixQuote(target.cliHomeDir)}`,
  );
}

export function buildRemoteBootstrapCommand(target) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "SilentlyContinue"',
        `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
        'if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required on the remote target" }',
        'if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw "Corepack is required on the remote target" }',
        '$installExitCode = 1',
        'for ($attempt = 1; $attempt -le 3; $attempt++) { corepack yarn install --frozen-lockfile; $installExitCode = $LASTEXITCODE; if ($installExitCode -eq 0) { break }; if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) } }',
        'if ($installExitCode -ne 0) { exit $installExitCode }',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `cd -- ${posixQuote(target.repoDir)}`,
      'command -v node >/dev/null || { echo "Node.js is required on the remote target" >&2; exit 127; }',
      'command -v corepack >/dev/null || { echo "Corepack is required on the remote target" >&2; exit 127; }',
      'corepack yarn install --frozen-lockfile',
    ].join('; '),
  );
}

export function buildRemoteDoctorCommand(target) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        'if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required on the remote target" }',
        'if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw "Corepack is required on the remote target" }',
        'node --version',
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        'corepack --version',
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      'command -v node >/dev/null || { echo "Node.js is required on the remote target" >&2; exit 127; }',
      'command -v corepack >/dev/null || { echo "Corepack is required on the remote target" >&2; exit 127; }',
      'node --version',
      'corepack --version',
    ].join('; '),
  );
}

export function buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath }) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$destination = ${powershellQuote(finalPath)}`,
        'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null',
        `Move-Item -Force -LiteralPath ${powershellQuote(stagedPath)} -Destination $destination`,
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `install -d -m 700 -- ${posixQuote(finalPath.slice(0, finalPath.lastIndexOf('/')))}`,
      `install -m 600 -- ${posixQuote(stagedPath)} ${posixQuote(finalPath)}`,
      `rm -f -- ${posixQuote(stagedPath)}`,
    ].join('; '),
  );
}

export function buildRemoteDaemonCommand(target, { serverUrl, activeServerId, stackName }) {
  const stackStorageDir = `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/stack-state`;
  const stackBaseDir = `${stackStorageDir}/${stackName}`;
  const stackEnvPath = `${stackBaseDir}/env`;
  const stackEnvLines = [
    `HAPPIER_STACK_REPO_DIR=${target.repoDir}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${target.cliHomeDir}`,
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
    'HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000',
  ];
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$env:HAPPIER_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
        `$env:HAPPIER_STACK_CLI_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
        `$env:HAPPIER_STACK_STORAGE_DIR = ${powershellQuote(stackStorageDir)}`,
        `$env:HAPPIER_STACK_STACK = ${powershellQuote(stackName)}`,
        `$env:HAPPIER_ACTIVE_SERVER_ID = ${powershellQuote(activeServerId)}`,
        `$env:HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = ${powershellQuote(activeServerId)}`,
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(stackBaseDir)} | Out-Null`,
        `$stackEnvPath = ${powershellQuote(stackEnvPath)}`,
        `@(${stackEnvLines.map(powershellQuote).join(', ')}) | Set-Content -LiteralPath $stackEnvPath -Encoding Ascii`,
        `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
        `corepack yarn workspace @happier-dev/stack stack dev ${powershellQuote(stackName)} --no-server --no-ui --no-browser --no-dev-targets --watch --restart --server-url=${powershellQuote(serverUrl)}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `export HAPPIER_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
      `export HAPPIER_STACK_CLI_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
      `export HAPPIER_STACK_STORAGE_DIR=${posixQuote(stackStorageDir)}`,
      `export HAPPIER_STACK_STACK=${posixQuote(stackName)}`,
      `export HAPPIER_ACTIVE_SERVER_ID=${posixQuote(activeServerId)}`,
      `export HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID=${posixQuote(activeServerId)}`,
      `install -d -m 700 -- ${posixQuote(stackBaseDir)}`,
      `printf '%s\\n' ${stackEnvLines.map(posixQuote).join(' ')} > ${posixQuote(stackEnvPath)}`,
      `cd -- ${posixQuote(target.repoDir)}`,
      `exec corepack yarn workspace @happier-dev/stack stack dev ${posixQuote(stackName)} --no-server --no-ui --no-browser --no-dev-targets --watch --restart --server-url=${posixQuote(serverUrl)}`,
    ].join('; '),
  );
}

export function buildSshWorkerArgs(
  target,
  { localServerPort, remoteServerPort, remoteCommand, sshArgs = [] },
) {
  return [
    target.platform === 'windows' ? '-T' : '-tt',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    `127.0.0.1:${remoteServerPort}:127.0.0.1:${localServerPort}`,
    target.ssh,
    remoteCommand,
  ];
}
