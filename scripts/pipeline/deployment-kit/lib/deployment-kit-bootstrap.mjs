// @ts-check

const BOOTSTRAP_ROLES = new Set(['agent', 'controller', 'ssh-agent']);
const BOOTSTRAP_SHELLS = new Set(['posix', 'powershell']);

const POWERSHELL_PREAMBLE = String.raw`Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Resolve-VerifiedRegularFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Label path is required."
  }

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($root)) {
    throw "$Label path cannot be resolved."
  }

  $current = $root
  $remaining = $fullPath.Substring($root.Length)
  foreach ($segment in ($remaining -split '[\\/]')) {
    if ([string]::IsNullOrEmpty($segment)) {
      continue
    }
    $current = [System.IO.Path]::Combine($current, $segment)
    $component = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($component.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label path must not contain a reparse point."
    }
  }

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer) {
    throw "$Label path must be a regular file."
  }
  return $fullPath
}

function Assert-HappierExitCode {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ExitCode,
    [Parameter(Mandatory = $true)]
    [string]$Operation
  )
  if ($ExitCode -ne 0) {
    throw "$Operation failed with exit code $ExitCode."
  }
}`;

const POWERSHELL_CONTROLLER = String.raw`#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$HappierBinary,
  [Parameter(Mandatory = $true)]
  [string]$ServerBinary
)

${POWERSHELL_PREAMBLE}

$happierPath = Resolve-VerifiedRegularFile -Path $HappierBinary -Label 'Happier binary'
$serverBinaryPath = Resolve-VerifiedRegularFile -Path $ServerBinary -Label 'Relay server binary'

if (Test-Path -LiteralPath 'Env:HAPPIER_BOOTSTRAP_RELAY_PORT') {
  throw 'HAPPIER_BOOTSTRAP_RELAY_PORT is not accepted; this bootstrap is fixed to the manifest port 3005.'
}

& $happierPath relay host install --server-binary $serverBinaryPath --host '127.0.0.1' --mode user --yes --json --env 'PORT=3005'
$relayInstallExitCode = $LASTEXITCODE
Assert-HappierExitCode -ExitCode $relayInstallExitCode -Operation 'Relay host install'
`;

const POWERSHELL_AGENT = String.raw`#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$HappierBinary,
  [Parameter(Mandatory = $true)]
  [string]$ServerUrl,
  [string]$WebappUrl = ''
)

${POWERSHELL_PREAMBLE}

function Resolve-VerifiedHttpsUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  [System.Uri]$uri = $null
  if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri)) {
    throw "$Label must be an absolute HTTPS URL."
  }
  if ($uri.Scheme -cne 'https' -or [string]::IsNullOrWhiteSpace($uri.Host)) {
    throw "$Label must use HTTPS."
  }
  if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw "$Label must not contain user info, a query, or a fragment."
  }
  return $Value.Trim()
}

$happierPath = Resolve-VerifiedRegularFile -Path $HappierBinary -Label 'Happier binary'
$relayUrlValue = Resolve-VerifiedHttpsUrl -Value $ServerUrl -Label 'Relay URL'
if ([string]::IsNullOrWhiteSpace($WebappUrl)) {
  $WebappUrl = $relayUrlValue
}
$webappUrlValue = Resolve-VerifiedHttpsUrl -Value $WebappUrl -Label 'Web app URL'

& $happierPath server set --server-url $relayUrlValue --webapp-url $webappUrlValue --json
$serverSetExitCode = $LASTEXITCODE
Assert-HappierExitCode -ExitCode $serverSetExitCode -Operation 'Relay profile setup'

& $happierPath auth login --no-open --server-url $relayUrlValue --webapp-url $webappUrlValue --persist
$authExitCode = $LASTEXITCODE
Assert-HappierExitCode -ExitCode $authExitCode -Operation 'Authentication'

& $happierPath service install --mode user --yes --json
$serviceInstallExitCode = $LASTEXITCODE
Assert-HappierExitCode -ExitCode $serviceInstallExitCode -Operation 'Background service install'
`;

const POWERSHELL_SSH_AGENT = String.raw`#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$HappierBinary,
  [Parameter(Mandatory = $true)]
  [string]$SshTarget,
  [Parameter(Mandatory = $true)]
  [string]$CliPayload,
  [Parameter(Mandatory = $true)]
  [string]$ServerUrl,
  [string]$WebappUrl = '',
  [switch]$Yes
)

${POWERSHELL_PREAMBLE}

function Resolve-VerifiedPayloadDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'CLI payload path is required.'
  }

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($root)) {
    throw 'CLI payload path cannot be resolved.'
  }

  $current = $root
  $remaining = $fullPath.Substring($root.Length)
  foreach ($segment in ($remaining -split '[\\/]')) {
    if ([string]::IsNullOrEmpty($segment)) {
      continue
    }
    $current = [System.IO.Path]::Combine($current, $segment)
    $component = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($component.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'CLI payload path must not contain a reparse point.'
    }
  }

  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) {
    throw 'CLI payload path must be a directory.'
  }
  return $fullPath
}

function Resolve-VerifiedHttpsUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  [System.Uri]$uri = $null
  if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri)) {
    throw "$Label must be an absolute HTTPS URL."
  }
  if ($uri.Scheme -cne 'https' -or [string]::IsNullOrWhiteSpace($uri.Host)) {
    throw "$Label must use HTTPS."
  }
  if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw "$Label must not contain user info, a query, or a fragment."
  }
  return $Value.Trim()
}

$happierPath = Resolve-VerifiedRegularFile -Path $HappierBinary -Label 'Happier binary'
if ([string]::IsNullOrWhiteSpace($SshTarget)) {
  throw 'SSH target is required.'
}
$sshTargetValue = $SshTarget.Trim()
$cliPayloadPath = Resolve-VerifiedPayloadDirectory -Path $CliPayload
$relayUrlValue = Resolve-VerifiedHttpsUrl -Value $ServerUrl -Label 'Relay URL'
if ([string]::IsNullOrWhiteSpace($WebappUrl)) {
  $WebappUrl = $relayUrlValue
}
$webappUrlValue = Resolve-VerifiedHttpsUrl -Value $WebappUrl -Label 'Web app URL'

$machineArgs = @('machine', 'setup', '--ssh', $sshTargetValue, '--cli-payload', $cliPayloadPath, '--server-url', $relayUrlValue, '--webapp-url', $webappUrlValue)
if ($Yes.IsPresent) {
  $machineArgs += '--yes'
}

& $happierPath @machineArgs
$machineSetupExitCode = $LASTEXITCODE
Assert-HappierExitCode -ExitCode $machineSetupExitCode -Operation 'SSH Agent setup'
`;

const POSIX_PREAMBLE = String.raw`set -efu

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_no_symlink_components() {
  candidate=$1
  case "$candidate" in
    /*) absolute_path=$candidate ;;
    *) absolute_path=$PWD/$candidate ;;
  esac

  remaining_path=${'${absolute_path#/}'}
  current_path=
  previous_ifs=$IFS
  IFS=/
  set -- $remaining_path
  IFS=$previous_ifs
  for path_segment do
    [ -n "$path_segment" ] || continue
    current_path=$current_path/$path_segment
    [ ! -L "$current_path" ] || die "Path must not contain a symbolic link."
  done
}

require_executable_file() {
  candidate=$1
  label=$2
  [ -n "$candidate" ] || die "$label path is required."
  assert_no_symlink_components "$candidate"
  [ -f "$candidate" ] || die "$label path must be a regular file."
  [ ! -L "$candidate" ] || die "$label path must not be a symbolic link."
  [ -x "$candidate" ] || die "$label path must be executable."
}

run_happier() {
  operation=$1
  shift
  if ! "$@"; then
    die "$operation failed."
  fi
}`;

const POSIX_CONTROLLER = String.raw`#!/bin/sh
${POSIX_PREAMBLE}

[ "$#" -eq 2 ] || die "Usage: controller.sh <happier-binary> <relay-server-binary>"
happier_binary=$1
server_binary=$2
require_executable_file "$happier_binary" "Happier binary"
require_executable_file "$server_binary" "Relay server binary"

if [ "${'${HAPPIER_BOOTSTRAP_RELAY_PORT+x}'}" = x ]; then
  die "HAPPIER_BOOTSTRAP_RELAY_PORT is not accepted; this bootstrap is fixed to the manifest port 3005."
fi

run_happier "Relay host install" "$happier_binary" relay host install --server-binary "$server_binary" --host 127.0.0.1 --mode user --yes --json --env PORT=3005
`;

const POSIX_AGENT = String.raw`#!/bin/sh
${POSIX_PREAMBLE}

require_https_url() {
  url_value=$1
  url_label=$2
  case "$url_value" in
    https://?*) ;;
    *) die "$url_label must be an absolute HTTPS URL." ;;
  esac
  case "$url_value" in
    *'@'*|*'?'*|*'#'*|*[[:space:]]*) die "$url_label must not contain user info, a query, a fragment, or whitespace." ;;
  esac
  url_remainder=${'${url_value#https://}'}
  url_authority=${'${url_remainder%%/*}'}
  case "$url_authority" in
    ''|:*) die "$url_label must include a host." ;;
  esac
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || die "Usage: agent.sh <happier-binary> <https-relay-url> [https-webapp-url]"
happier_binary=$1
relay_url=$2
webapp_url=$relay_url
if [ "$#" -eq 3 ]; then
  webapp_url=$3
fi

require_executable_file "$happier_binary" "Happier binary"
require_https_url "$relay_url" "Relay URL"
require_https_url "$webapp_url" "Web app URL"

run_happier "Relay profile setup" "$happier_binary" server set --server-url "$relay_url" --webapp-url "$webapp_url" --json
run_happier "Authentication" "$happier_binary" auth login --no-open --server-url "$relay_url" --webapp-url "$webapp_url" --persist
run_happier "Background service install" "$happier_binary" service install --mode user --yes --json
`;

const POSIX_SSH_AGENT = String.raw`#!/bin/sh
${POSIX_PREAMBLE}

require_directory() {
  candidate=$1
  label=$2
  [ -n "$candidate" ] || die "$label path is required."
  assert_no_symlink_components "$candidate"
  [ -d "$candidate" ] || die "$label path must be a directory."
  [ ! -L "$candidate" ] || die "$label path must not be a symbolic link."
}

require_https_url() {
  url_value=$1
  url_label=$2
  case "$url_value" in
    https://?*) ;;
    *) die "$url_label must be an absolute HTTPS URL." ;;
  esac
  case "$url_value" in
    *'@'*|*'?'*|*'#'*|*[[:space:]]*) die "$url_label must not contain user info, a query, a fragment, or whitespace." ;;
  esac
  url_remainder=${'${url_value#https://}'}
  url_authority=${'${url_remainder%%/*}'}
  case "$url_authority" in
    ''|:*) die "$url_label must include a host." ;;
  esac
}

usage='Usage: ssh-agent.sh <happier-binary> <ssh-target> <extracted-cli-payload-root> <https-relay-url> [https-webapp-url] [--yes]'
[ "$#" -ge 4 ] && [ "$#" -le 6 ] || die "$usage"
happier_binary=$1
ssh_target=$2
cli_payload=$3
relay_url=$4
shift 4
webapp_url=$relay_url
assume_yes=0
case "$#" in
  0) ;;
  1)
    if [ "$1" = --yes ]; then
      assume_yes=1
    else
      webapp_url=$1
    fi
    ;;
  2)
    [ "$2" = --yes ] || die "$usage"
    webapp_url=$1
    assume_yes=1
    ;;
  *) die "$usage" ;;
esac

require_executable_file "$happier_binary" "Happier binary"
[ -n "$ssh_target" ] || die "SSH target is required."
require_directory "$cli_payload" "CLI payload"
require_https_url "$relay_url" "Relay URL"
require_https_url "$webapp_url" "Web app URL"

if [ "$assume_yes" -eq 1 ]; then
  run_happier "SSH Agent setup" "$happier_binary" machine setup --ssh "$ssh_target" --cli-payload "$cli_payload" --server-url "$relay_url" --webapp-url "$webapp_url" --yes
else
  run_happier "SSH Agent setup" "$happier_binary" machine setup --ssh "$ssh_target" --cli-payload "$cli_payload" --server-url "$relay_url" --webapp-url "$webapp_url"
fi
`;

const BOOTSTRAPS = Object.freeze({
  agent: Object.freeze({
    posix: POSIX_AGENT,
    powershell: POWERSHELL_AGENT,
  }),
  controller: Object.freeze({
    posix: POSIX_CONTROLLER,
    powershell: POWERSHELL_CONTROLLER,
  }),
  'ssh-agent': Object.freeze({
    posix: POSIX_SSH_AGENT,
    powershell: POWERSHELL_SSH_AGENT,
  }),
});

function requireBootstrapChoice(value, allowed, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`[deployment-kit] unsupported bootstrap ${label}: ${normalized || '(missing)'}`);
  }
  return normalized;
}

export function renderDeploymentKitBootstrap(input) {
  const role = requireBootstrapChoice(input?.role, BOOTSTRAP_ROLES, 'role');
  const shell = requireBootstrapChoice(input?.shell, BOOTSTRAP_SHELLS, 'shell');
  return `${BOOTSTRAPS[role][shell].trimEnd()}\n`;
}

export function createDeploymentKitBootstrapFiles() {
  return [
    { path: 'bootstrap/agent.ps1', role: 'agent', shell: 'powershell', mode: 0o644 },
    { path: 'bootstrap/agent.sh', role: 'agent', shell: 'posix', mode: 0o755 },
    { path: 'bootstrap/controller.ps1', role: 'controller', shell: 'powershell', mode: 0o644 },
    { path: 'bootstrap/controller.sh', role: 'controller', shell: 'posix', mode: 0o755 },
    { path: 'bootstrap/ssh-agent.ps1', role: 'ssh-agent', shell: 'powershell', mode: 0o644 },
    { path: 'bootstrap/ssh-agent.sh', role: 'ssh-agent', shell: 'posix', mode: 0o755 },
  ].map((entry) => ({
    ...entry,
    contents: renderDeploymentKitBootstrap({ role: entry.role, shell: entry.shell }),
  }));
}
