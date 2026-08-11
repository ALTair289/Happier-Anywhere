// @ts-check

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, posix, resolve, sep } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import { createDeploymentKitBootstrapFiles } from './deployment-kit-bootstrap.mjs';
import {
  createProjectGuide,
  createProjectGuideChinese,
} from './deployment-kit-github-readme.mjs';
import {
  DEPLOYMENT_PROJECT_SAFE_EXTRACT_SCRIPT,
  DEPLOYMENT_PROJECT_SAFE_EXTRACT_TEST,
  DEPLOYMENT_PROJECT_VERIFY_SCRIPT,
  DEPLOYMENT_PROJECT_VERIFY_WORKFLOW,
} from './deployment-kit-github-verification.mjs';
import {
  assertDeploymentKitManifestSchema,
  HAPPIER_DEPLOYMENT_KIT_TARGETS,
} from './deployment-kit-schema.mjs';
import { assertCompleteDeploymentKitArtifactCoverage } from './deployment-kit-manifest.mjs';

export const HAPPIER_DEPLOYMENT_CATALOG_SCHEMA_VERSION = 'happier-deployment-catalog/v1';
export const HAPPIER_DEPLOYMENT_REPOSITORY_AVAILABILITIES = Object.freeze([
  'not-verified',
  'verified',
]);

const PROFILE_REQUIRED_ROLES = Object.freeze({
  agent: Object.freeze(['agent']),
  controller: Object.freeze(['agent', 'controller']),
  'ssh-agent': Object.freeze(['agent']),
});

const safeSegment = {
  type: 'string',
  minLength: 1,
  pattern: '^[0-9A-Za-z][0-9A-Za-z._+-]*$',
};

const closedObject = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const canonicalTargetSchema = (target) => closedObject(Object.fromEntries(
  Object.entries(target).map(([key, value]) => [key, { const: value }]),
));

export const deploymentGitHubCatalogJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://happier.dev/schemas/deployment-catalog/v1.json',
  title: 'Happier modular GitHub deployment catalog v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'product',
    'kitVersion',
    'channel',
    'repository',
    'source',
    'compatibility',
    'securityPolicy',
    'mobile',
    'profiles',
    'artifacts',
  ],
  properties: {
    schemaVersion: { const: HAPPIER_DEPLOYMENT_CATALOG_SCHEMA_VERSION },
    product: { const: 'happier-deployment-catalog' },
    kitVersion: { $ref: '#/$defs/safeSegment' },
    channel: { enum: ['local', 'dev', 'preview', 'stable'] },
    repository: closedObject({
      slug: { type: 'string', pattern: '^[0-9A-Za-z][0-9A-Za-z._-]*/[0-9A-Za-z][0-9A-Za-z._-]*$' },
      host: { const: 'github.com' },
      availability: { enum: HAPPIER_DEPLOYMENT_REPOSITORY_AVAILABILITIES },
    }),
    source: { type: 'object' },
    compatibility: { type: 'object' },
    securityPolicy: { type: 'object' },
    mobile: { type: 'object' },
    profiles: closedObject({
      agent: { $ref: '#/$defs/profile' },
      controller: { $ref: '#/$defs/profile' },
      'ssh-agent': { $ref: '#/$defs/profile' },
    }),
    artifacts: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/artifact' },
    },
  },
  $defs: {
    safeSegment,
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    target: { oneOf: HAPPIER_DEPLOYMENT_KIT_TARGETS.map(canonicalTargetSchema) },
    profile: closedObject({
      requiredRoles: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { enum: ['agent', 'controller'] },
      },
      allowedTargetIds: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { $ref: '#/$defs/safeSegment' },
      },
    }),
    release: closedObject({
      tag: { $ref: '#/$defs/safeSegment' },
      assetName: { type: 'string', pattern: '^[0-9A-Za-z][0-9A-Za-z._+-]*\\.tar\\.gz$' },
      url: { type: 'string', pattern: '^https://github\\.com/' },
      checksumsAssetName: { type: 'string', pattern: '^checksums-[0-9A-Za-z._+-]+\\.txt$' },
      checksumsUrl: { type: 'string', pattern: '^https://github\\.com/' },
      signatureAssetName: { type: 'string', pattern: '^checksums-[0-9A-Za-z._+-]+\\.txt\\.minisig$' },
      signatureUrl: { type: 'string', pattern: '^https://github\\.com/' },
    }),
    artifact: closedObject({
      id: { $ref: '#/$defs/safeSegment' },
      role: { enum: ['agent', 'controller'] },
      target: { $ref: '#/$defs/target' },
      targetId: { $ref: '#/$defs/safeSegment' },
      variant: { const: 'native' },
      format: { const: 'tar.gz' },
      sha256: { $ref: '#/$defs/sha256' },
      size: { type: 'integer', minimum: 1 },
      release: { $ref: '#/$defs/release' },
    }),
  },
};

const catalogValidator = new Ajv2020({ allErrors: true, strict: true })
  .compile(deploymentGitHubCatalogJsonSchema);

export function assertDeploymentGitHubCatalogSchema(catalog) {
  if (catalogValidator(catalog)) {
    assertDeploymentGitHubCatalogSemantics(catalog);
    return catalog;
  }
  const failures = (catalogValidator.errors ?? [])
    .map((error) => `${error.instancePath || '/'}:${error.keyword}`)
    .join(', ');
  throw new Error(`[deployment-kit] GitHub catalog does not satisfy the v1 JSON Schema${failures ? ` (${failures})` : ''}`);
}

function assertExactCatalogStringArray(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`[deployment-kit] GitHub catalog ${label} must match the canonical artifact inventory`);
  }
}

export function assertDeploymentGitHubCatalogSemantics(catalog) {
  assertCompleteDeploymentKitArtifactCoverage(catalog.artifacts);
  const ids = new Set();
  const identities = new Set();
  for (const artifact of catalog.artifacts) {
    const expectedTargetId = targetId(artifact.target);
    if (artifact.targetId !== expectedTargetId) {
      throw new Error(`[deployment-kit] GitHub catalog artifact targetId mismatch: ${artifact.id}`);
    }
    if (ids.has(artifact.id)) {
      throw new Error(`[deployment-kit] duplicate GitHub catalog artifact id: ${artifact.id}`);
    }
    ids.add(artifact.id);
    const identity = `${artifact.role}/${expectedTargetId}/${artifact.variant}`;
    if (identities.has(identity)) {
      throw new Error(`[deployment-kit] duplicate GitHub catalog artifact role/target/variant: ${identity}`);
    }
    identities.add(identity);
  }

  const targetIds = [...new Set(HAPPIER_DEPLOYMENT_KIT_TARGETS.map((target) => targetId(target)))].sort();
  const sshTargetIds = targetIds.filter((id) => !id.startsWith('windows-'));
  const expectedProfiles = {
    agent: { requiredRoles: PROFILE_REQUIRED_ROLES.agent, allowedTargetIds: targetIds },
    controller: { requiredRoles: PROFILE_REQUIRED_ROLES.controller, allowedTargetIds: targetIds },
    'ssh-agent': { requiredRoles: PROFILE_REQUIRED_ROLES['ssh-agent'], allowedTargetIds: sshTargetIds },
  };
  for (const [profile, expected] of Object.entries(expectedProfiles)) {
    assertExactCatalogStringArray(
      catalog.profiles[profile].requiredRoles,
      expected.requiredRoles,
      `${profile} requiredRoles`,
    );
    assertExactCatalogStringArray(
      catalog.profiles[profile].allowedTargetIds,
      expected.allowedTargetIds,
      `${profile} allowedTargetIds`,
    );
  }
  return catalog;
}

function requireRepositorySlug(value) {
  const normalized = String(value ?? '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*\/[0-9A-Za-z][0-9A-Za-z._-]*$/.test(normalized)) {
    throw new Error(`[deployment-kit] invalid GitHub repository slug: ${normalized || '<empty>'}`);
  }
  return normalized;
}

function requireRepositoryAvailability(value) {
  const normalized = String(value ?? 'not-verified').trim().toLowerCase();
  if (!HAPPIER_DEPLOYMENT_REPOSITORY_AVAILABILITIES.includes(normalized)) {
    throw new Error(`[deployment-kit] invalid GitHub repository availability: ${normalized || '<empty>'}`);
  }
  return normalized;
}

function targetId(target) {
  return [target.os, target.arch, target.libc].filter(Boolean).join('-');
}

function requireVerifiedSources(manifest, verifiedSources) {
  if (!Array.isArray(verifiedSources)) {
    throw new Error('[deployment-kit] verified source inventory is required');
  }
  const byId = new Map();
  for (const source of verifiedSources) {
    const id = String(source?.artifactId ?? '').trim();
    if (!id || byId.has(id)) {
      throw new Error(`[deployment-kit] duplicate or invalid verified source: ${id || '<empty>'}`);
    }
    const archiveName = String(source?.archiveName ?? '').trim();
    const checksumsName = String(source?.checksumsName ?? '').trim();
    if (posix.basename(archiveName) !== archiveName || posix.basename(checksumsName) !== checksumsName) {
      throw new Error(`[deployment-kit] invalid verified source asset name: ${id}`);
    }
    byId.set(id, { archiveName, checksumsName });
  }
  const expected = manifest.artifacts.map((artifact) => artifact.id).sort();
  const actual = [...byId.keys()].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('[deployment-kit] verified source identities must match catalog artifacts exactly');
  }
  return byId;
}

function releaseIdentity(manifest, artifact, source, repository) {
  const component = artifact.role === 'controller'
    ? { tag: `server-v${manifest.compatibility.relay}` }
    : { tag: `cli-v${manifest.compatibility.cli}` };
  const baseUrl = `https://github.com/${repository}/releases/download/${component.tag}`;
  const signatureAssetName = `${source.checksumsName}.minisig`;
  return {
    tag: component.tag,
    assetName: source.archiveName,
    url: `${baseUrl}/${source.archiveName}`,
    checksumsAssetName: source.checksumsName,
    checksumsUrl: `${baseUrl}/${source.checksumsName}`,
    signatureAssetName,
    signatureUrl: `${baseUrl}/${signatureAssetName}`,
  };
}

export function createDeploymentGitHubCatalog({
  manifest,
  verifiedSources,
  repository,
  repositoryAvailability = 'not-verified',
}) {
  const normalizedManifest = assertDeploymentKitManifestSchema(structuredClone(manifest));
  assertCompleteDeploymentKitArtifactCoverage(normalizedManifest.artifacts);
  const repositorySlug = requireRepositorySlug(repository);
  const normalizedRepositoryAvailability = requireRepositoryAvailability(repositoryAvailability);
  const sourcesById = requireVerifiedSources(normalizedManifest, verifiedSources);
  const artifacts = normalizedManifest.artifacts.map((artifact) => ({
    id: artifact.id,
    role: artifact.role,
    target: artifact.target,
    targetId: targetId(artifact.target),
    variant: artifact.variant,
    format: artifact.format,
    sha256: artifact.sha256,
    size: artifact.size,
    release: releaseIdentity(
      normalizedManifest,
      artifact,
      sourcesById.get(artifact.id),
      repositorySlug,
    ),
  }));
  const targetIds = [...new Set(artifacts.map((artifact) => artifact.targetId))].sort();
  const sshTargetIds = targetIds.filter((id) => !id.startsWith('windows-'));
  if (sshTargetIds.length === 0) {
    throw new Error('[deployment-kit] GitHub catalog requires at least one Linux or macOS SSH Agent target');
  }
  const catalog = {
    schemaVersion: HAPPIER_DEPLOYMENT_CATALOG_SCHEMA_VERSION,
    product: 'happier-deployment-catalog',
    kitVersion: normalizedManifest.kitVersion,
    channel: normalizedManifest.channel,
    repository: {
      slug: repositorySlug,
      host: 'github.com',
      availability: normalizedRepositoryAvailability,
    },
    source: normalizedManifest.source,
    compatibility: normalizedManifest.compatibility,
    securityPolicy: normalizedManifest.securityPolicy,
    mobile: normalizedManifest.mobile,
    profiles: {
      agent: { requiredRoles: [...PROFILE_REQUIRED_ROLES.agent], allowedTargetIds: targetIds },
      controller: { requiredRoles: [...PROFILE_REQUIRED_ROLES.controller], allowedTargetIds: targetIds },
      'ssh-agent': { requiredRoles: [...PROFILE_REQUIRED_ROLES['ssh-agent']], allowedTargetIds: sshTargetIds },
    },
    artifacts,
  };
  return assertDeploymentGitHubCatalogSchema(catalog);
}

export function selectDeploymentGitHubAssets(catalog, { profile, targetId: requestedTargetId }) {
  const normalizedCatalog = assertDeploymentGitHubCatalogSchema(structuredClone(catalog));
  const normalizedProfile = String(profile ?? '').trim().toLowerCase();
  const profileDefinition = normalizedCatalog.profiles[normalizedProfile];
  if (!profileDefinition) {
    throw new Error(`[deployment-kit] unsupported GitHub deployment profile: ${normalizedProfile || '<empty>'}`);
  }
  const normalizedTargetId = String(requestedTargetId ?? '').trim().toLowerCase();
  if (!profileDefinition.allowedTargetIds.includes(normalizedTargetId)) {
    throw new Error(`[deployment-kit] target is not available for ${normalizedProfile}: ${normalizedTargetId || '<empty>'}`);
  }
  return profileDefinition.requiredRoles.map((role) => {
    const matches = normalizedCatalog.artifacts.filter((artifact) => (
      artifact.role === role && artifact.targetId === normalizedTargetId
    ));
    if (matches.length !== 1) {
      throw new Error(`[deployment-kit] expected exactly one ${role} asset for ${normalizedTargetId}`);
    }
    return matches[0];
  });
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assetsTsv(catalog) {
  const header = [
    'id',
    'role',
    'targetId',
    'assetName',
    'sha256',
    'size',
    'url',
    'checksumsAssetName',
    'checksumsUrl',
    'signatureAssetName',
    'signatureUrl',
  ];
  const rows = catalog.artifacts.map((artifact) => [
    artifact.id,
    artifact.role,
    artifact.targetId,
    artifact.release.assetName,
    artifact.sha256,
    String(artifact.size),
    artifact.release.url,
    artifact.release.checksumsAssetName,
    artifact.release.checksumsUrl,
    artifact.release.signatureAssetName,
    artifact.release.signatureUrl,
  ]);
  return [...rows.map((row) => row.join('\t'))].reduce(
    (text, row) => `${text}${row}\n`,
    `${header.join('\t')}\n`,
  );
}

const FETCH_POWERSHELL = String.raw`#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('agent', 'controller', 'ssh-agent')]
  [string]$Role = 'agent',
  [string]$TargetId = '',
  [string]$OutDir = '',
  [switch]$Plan
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$catalogPath = Join-Path $projectRoot 'catalog.json'
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($TargetId)) {
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  $arch = if ($architecture -eq 'x64') { 'x64' } elseif ($architecture -eq 'arm64') { 'arm64' } else { throw "Unsupported architecture: $architecture" }
  if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
    $TargetId = "windows-$arch"
  }
  elseif ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Linux)) {
    $TargetId = "linux-$arch-glibc"
  }
  elseif ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)) {
    $TargetId = "darwin-$arch"
  }
  else {
    throw 'Unsupported operating system.'
  }
}

$profileProperty = $catalog.profiles.PSObject.Properties[$Role]
if ($null -eq $profileProperty) { throw "Unsupported role: $Role" }
$profile = $profileProperty.Value
if (@($profile.allowedTargetIds) -notcontains $TargetId) { throw ("Target is not available for {0}: {1}" -f $Role, $TargetId) }
$selected = @()
foreach ($requiredRole in @($profile.requiredRoles)) {
  $matches = @($catalog.artifacts | Where-Object { $_.role -eq $requiredRole -and $_.targetId -eq $TargetId })
  if ($matches.Count -ne 1) { throw "Expected exactly one $requiredRole asset for $TargetId" }
  $selected += $matches[0]
}

if ($Plan.IsPresent) {
  $selected | Select-Object id, role, targetId, size, sha256, @{Name='url';Expression={$_.release.url}} | ConvertTo-Json -Depth 4
  exit 0
}

if ([string]::IsNullOrWhiteSpace($OutDir)) { throw '-OutDir is required unless -Plan is used.' }
$outFullPath = [System.IO.Path]::GetFullPath($OutDir)
if (Test-Path -LiteralPath $outFullPath) { throw "Output already exists: $outFullPath" }
$outParent = Split-Path -Parent $outFullPath
if ([string]::IsNullOrWhiteSpace($outParent)) { throw 'Output parent cannot be resolved.' }
New-Item -ItemType Directory -Path $outParent -Force | Out-Null
$stage = Join-Path $outParent ('.happier-download-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null

function Assert-GitHubHttpsUrl([string]$Value) {
  [Uri]$uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -cne 'https' -or $uri.Host -cne 'github.com' -or $uri.UserInfo) {
    throw "Refusing non-GitHub HTTPS URL."
  }
}

function Assert-SafeAssetName([string]$Value, [string]$Label, [string]$Pattern) {
  if ([string]::IsNullOrWhiteSpace($Value) -or [System.IO.Path]::GetFileName($Value) -cne $Value -or $Value -notmatch $Pattern) {
    throw "Unsafe $Label metadata."
  }
}

function Resolve-StageAssetPath([string]$StageRoot, [string]$AssetName) {
  $stageFullPath = [System.IO.Path]::GetFullPath($StageRoot)
  $candidatePath = [System.IO.Path]::GetFullPath((Join-Path $stageFullPath $AssetName))
  $stagePrefix = $stageFullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $candidatePath.StartsWith($stagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Asset path escapes the staging directory.'
  }
  return $candidatePath
}

try {
  $minisign = Get-Command minisign -ErrorAction Stop
  $publicKey = Join-Path $projectRoot 'happier-release.pub'
  foreach ($asset in $selected) {
    $assetName = [string]$asset.release.assetName
    $checksumsName = [string]$asset.release.checksumsAssetName
    $signatureName = [string]$asset.release.signatureAssetName
    Assert-SafeAssetName $assetName 'archive name' '^[0-9A-Za-z][0-9A-Za-z._+-]*\.tar\.gz$'
    Assert-SafeAssetName $checksumsName 'checksum name' '^checksums-[0-9A-Za-z._+-]+\.txt$'
    Assert-SafeAssetName $signatureName 'signature name' '^checksums-[0-9A-Za-z._+-]+\.txt\.minisig$'
    Assert-GitHubHttpsUrl ([string]$asset.release.url)
    Assert-GitHubHttpsUrl ([string]$asset.release.checksumsUrl)
    Assert-GitHubHttpsUrl ([string]$asset.release.signatureUrl)
    $checksumsPath = Resolve-StageAssetPath $stage $checksumsName
    $signaturePath = Resolve-StageAssetPath $stage $signatureName
    Invoke-WebRequest -UseBasicParsing -Uri $asset.release.checksumsUrl -OutFile $checksumsPath
    Invoke-WebRequest -UseBasicParsing -Uri $asset.release.signatureUrl -OutFile $signaturePath
    & $minisign.Source -Vm $checksumsPath -x $signaturePath -p $publicKey *> $null
    if ($LASTEXITCODE -ne 0) { throw "Minisign verification failed for $($asset.id)." }

    $receiptSha = $null
    foreach ($line in Get-Content -LiteralPath $checksumsPath) {
      if ($line -match '^([a-fA-F0-9]{64})  ([0-9A-Za-z][0-9A-Za-z._+-]*\.tar\.gz)$' -and $matches[2] -ceq $assetName) {
        if ($null -ne $receiptSha) { throw "Duplicate checksum entry for $($asset.id)." }
        $receiptSha = $matches[1].ToLowerInvariant()
      }
    }
    if ($null -eq $receiptSha -or $receiptSha -cne ([string]$asset.sha256)) { throw "Signed checksum mismatch for $($asset.id)." }

    $archivePath = Resolve-StageAssetPath $stage $assetName
    Invoke-WebRequest -UseBasicParsing -Uri $asset.release.url -OutFile $archivePath
    $actualSha = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $actualSize = (Get-Item -LiteralPath $archivePath).Length
    if ($actualSha -cne ([string]$asset.sha256) -or $actualSize -ne [Int64]$asset.size) { throw "Downloaded artifact mismatch for $($asset.id)." }
  }
  Copy-Item -LiteralPath $catalogPath -Destination (Join-Path $stage 'catalog.json')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'happier-release.pub') -Destination (Join-Path $stage 'happier-release.pub')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'bootstrap') -Destination (Join-Path $stage 'bootstrap') -Recurse
  $selected | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stage 'selected-assets.json') -Encoding UTF8
  Move-Item -LiteralPath $stage -Destination $outFullPath
  Write-Output $outFullPath
}
catch {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  throw
}
`;

const FETCH_BASH = String.raw`#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${'${BASH_SOURCE[0]}'}")/.." && pwd -P)"
role=agent
target_id=
out_dir=
plan=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) role="${'${2:-}'}"; shift 2 ;;
    --target) target_id="${'${2:-}'}"; shift 2 ;;
    --out) out_dir="${'${2:-}'}"; shift 2 ;;
    --plan) plan=1; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$role" in agent|controller|ssh-agent) ;; *) printf 'Unsupported role: %s\n' "$role" >&2; exit 2 ;; esac
if [[ -z "$target_id" ]]; then
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) printf 'Unsupported operating system.\n' >&2; exit 2 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) printf 'Unsupported architecture.\n' >&2; exit 2 ;; esac
  if [[ "$os" == linux ]]; then target_id="linux-$arch-glibc"; else target_id="darwin-$arch"; fi
fi
if [[ "$role" == ssh-agent && "$target_id" == windows-* ]]; then printf 'SSH Agent target must be Linux or macOS.\n' >&2; exit 2; fi

required_roles=agent
if [[ "$role" == controller ]]; then required_roles='agent controller'; fi
selected_file="$(mktemp)"
trap 'rm -f "$selected_file"' EXIT
for required_role in $required_roles; do
  role_count="$(awk -F '\t' -v role="$required_role" -v target="$target_id" 'NR > 1 && $2 == role && $3 == target { count++ } END { print count + 0 }' "$project_root/assets.tsv")"
  [[ "$role_count" == 1 ]] || { printf 'Expected exactly one %s asset for %s.\n' "$required_role" "$target_id" >&2; exit 2; }
  awk -F '\t' -v role="$required_role" -v target="$target_id" 'NR > 1 && $2 == role && $3 == target { print }' "$project_root/assets.tsv" >> "$selected_file"
done
if [[ "$plan" == 1 ]]; then cat "$selected_file"; exit 0; fi
[[ -n "$out_dir" ]] || { printf '%s\n' '--out is required unless --plan is used.' >&2; exit 2; }
[[ ! -e "$out_dir" ]] || { printf 'Output already exists: %s\n' "$out_dir" >&2; exit 2; }
command -v curl >/dev/null || { printf 'curl is required.\n' >&2; exit 2; }
command -v minisign >/dev/null || { printf 'minisign is required.\n' >&2; exit 2; }

out_parent="$(dirname "$out_dir")"
mkdir -p "$out_parent"
stage="$(mktemp -d "$out_parent/.happier-download.XXXXXX")"
cleanup_stage() { rm -rf "$stage"; }
trap 'rm -f "$selected_file"; cleanup_stage' EXIT

sha256_file() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

awk -F '\t' 'NF != 11 { exit 1 }' "$selected_file" || { printf 'Unsafe asset metadata column count.\n' >&2; exit 2; }
while IFS=$'\t' read -r id asset_role asset_target asset_name expected_sha expected_size url checksums_name checksums_url signature_name signature_url; do
  [[ "$asset_name" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*\.tar\.gz$ ]] || { printf 'Unsafe archive name metadata.\n' >&2; exit 2; }
  [[ "$checksums_name" =~ ^checksums-[0-9A-Za-z._+-]+\.txt$ ]] || { printf 'Unsafe checksum name metadata.\n' >&2; exit 2; }
  [[ "$signature_name" =~ ^checksums-[0-9A-Za-z._+-]+\.txt\.minisig$ ]] || { printf 'Unsafe signature name metadata.\n' >&2; exit 2; }
  [[ "$expected_sha" =~ ^[a-f0-9]{64}$ && "$expected_size" =~ ^[1-9][0-9]*$ ]] || { printf 'Unsafe digest or size metadata.\n' >&2; exit 2; }
  case "$url$checksums_url$signature_url" in *$'\n'*|*$'\r'*|*$'\t'*) printf 'Unsafe URL metadata.\n' >&2; exit 2 ;; esac
  for candidate_url in "$url" "$checksums_url" "$signature_url"; do
    case "$candidate_url" in https://github.com/*) ;; *) printf 'Refusing non-GitHub HTTPS URL.\n' >&2; exit 2 ;; esac
  done
  checksums_path="$stage/$checksums_name"
  signature_path="$stage/$signature_name"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$checksums_path" "$checksums_url"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$signature_path" "$signature_url"
  minisign -Vm "$checksums_path" -x "$signature_path" -p "$project_root/happier-release.pub" >/dev/null
  receipt_sha="$(awk -v name="$asset_name" '$2 == name { if (found) exit 3; found=$1 } END { if (!found) exit 2; print found }' "$checksums_path")"
  [[ "$receipt_sha" == "$expected_sha" ]] || { printf 'Signed checksum mismatch for %s.\n' "$id" >&2; exit 1; }
  archive_path="$stage/$asset_name"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$archive_path" "$url"
  actual_sha="$(sha256_file "$archive_path")"
  actual_size="$(wc -c < "$archive_path" | tr -d ' ')"
  [[ "$actual_sha" == "$expected_sha" && "$actual_size" == "$expected_size" ]] || { printf 'Downloaded artifact mismatch for %s.\n' "$id" >&2; exit 1; }
done < "$selected_file"

cp "$project_root/catalog.json" "$project_root/happier-release.pub" "$stage/"
cp -R "$project_root/bootstrap" "$stage/bootstrap"
cp "$selected_file" "$stage/selected-assets.tsv"
mv "$stage" "$out_dir"
trap 'rm -f "$selected_file"' EXIT
printf '%s\n' "$out_dir"
`;

function safeProjectPath(value) {
  const normalized = posix.normalize(String(value ?? ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('\\') || normalized.startsWith('/')) {
    throw new Error(`[deployment-kit] unsafe GitHub project path: ${String(value)}`);
  }
  return normalized;
}

function pathInside(root, relativePath) {
  const safePath = safeProjectPath(relativePath);
  const rootPath = resolve(root);
  const destination = resolve(rootPath, ...safePath.split('/'));
  if (!destination.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`[deployment-kit] GitHub project path escapes output: ${relativePath}`);
  }
  return destination;
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function checksumText(files) {
  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([path, contents]) => `${sha256Bytes(contents)}  ${path}\n`)
    .join('');
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function normalizeMinisignPublicKey(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('[deployment-kit] explicit release public key is required');
  }
  const normalized = value.replace(/\r\n/g, '\n').trimEnd();
  const lines = normalized.split('\n');
  if (
    lines.length !== 2
    || !/^untrusted comment: minisign public key(?: [^\r\n]+)?$/.test(lines[0])
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(lines[1])
  ) {
    throw new Error('[deployment-kit] valid two-line Minisign public key is required');
  }
  const decoded = Buffer.from(lines[1], 'base64');
  if (
    decoded.length !== 42
    || decoded[0] !== 0x45
    || decoded[1] !== 0x64
    || decoded.toString('base64') !== lines[1]
  ) {
    throw new Error('[deployment-kit] valid two-line Minisign public key is required');
  }
  return normalized;
}

export async function materializeDeploymentGitHubProject({ catalog, outDir, releasePublicKey, licenseText }) {
  const normalizedCatalog = assertDeploymentGitHubCatalogSchema(structuredClone(catalog));
  if (typeof outDir !== 'string' || !outDir.trim()) {
    throw new Error('[deployment-kit] GitHub project output directory is required');
  }
  if (await pathExists(outDir)) {
    throw new Error(`[deployment-kit] GitHub project output already exists: ${outDir}`);
  }
  const publicKey = normalizeMinisignPublicKey(releasePublicKey);
  const license = String(licenseText ?? '');
  if (!/^MIT License\r?\n/.test(license) || !license.includes('Happy Coder Contributors')) {
    throw new Error('[deployment-kit] canonical Happier MIT LICENCE is required');
  }

  const files = new Map([
    ['.gitattributes', '* -text\n'],
    ['.gitignore', 'downloads/\n*.tar.gz\n*.minisig\n'],
    ['.github/workflows/verify.yml', `${DEPLOYMENT_PROJECT_VERIFY_WORKFLOW.trimEnd()}\n`],
    ['README.md', createProjectGuide(normalizedCatalog)],
    ['README.zh-CN.md', createProjectGuideChinese(normalizedCatalog)],
    ['LICENCE', license],
    ['catalog.json', jsonText(normalizedCatalog)],
    ['deployment-catalog.schema.json', jsonText(deploymentGitHubCatalogJsonSchema)],
    ['assets.tsv', assetsTsv(normalizedCatalog)],
    ['happier-release.pub', `${publicKey}\n`],
    ['scripts/fetch.ps1', `${FETCH_POWERSHELL.trimEnd()}\n`],
    ['scripts/fetch.sh', `${FETCH_BASH.trimEnd()}\n`],
    ['scripts/safe-extract.mjs', `${DEPLOYMENT_PROJECT_SAFE_EXTRACT_SCRIPT.trimEnd()}\n`],
    ['scripts/verify-project.mjs', `${DEPLOYMENT_PROJECT_VERIFY_SCRIPT.trimEnd()}\n`],
    ['tests/safe-extract.test.mjs', `${DEPLOYMENT_PROJECT_SAFE_EXTRACT_TEST.trimEnd()}\n`],
  ]);
  for (const bootstrap of createDeploymentKitBootstrapFiles()) {
    files.set(bootstrap.path, bootstrap.contents);
  }
  const checksums = checksumText(files);
  const resolvedOutDir = resolve(outDir);
  await mkdir(dirname(resolvedOutDir), { recursive: true });
  const stagingDir = await mkdtemp(`${resolvedOutDir}.staging-`);
  try {
    for (const [relativePath, contents] of files) {
      const destination = pathInside(stagingDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      const mode = relativePath.endsWith('.sh') ? 0o755 : 0o644;
      await writeFile(destination, contents, { flag: 'wx', mode });
    }
    await writeFile(pathInside(stagingDir, 'PROJECT-SHA256SUMS'), checksums, { flag: 'wx', mode: 0o644 });
    await rename(stagingDir, resolvedOutDir);
    return {
      outDir,
      projectTreeSha256: sha256Bytes(checksums),
      projectFileCount: files.size + 1,
      embeddedArtifactBytes: 0,
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function readCanonicalHappierReleasePublicKey(repoRoot) {
  const path = resolve(repoRoot, 'scripts', 'release', 'installers', 'happier-release.pub');
  return await readFile(path, 'utf8');
}

export async function readCanonicalHappierLicense(repoRoot) {
  const path = resolve(repoRoot, 'LICENCE');
  return await readFile(path, 'utf8');
}
