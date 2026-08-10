import { basename } from 'node:path';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type {
  FirstPartyComponentId,
  PreparedFirstPartyComponentPayload,
} from '../../firstPartyRuntime/index.js';
import {
  getFirstPartyComponentCatalogEntry,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveFirstPartyComponentPublicReleaseVariant,
} from '../../firstPartyRuntime/index.js';

import {
  FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME,
  normalizeFirstPartyPayloadSha256,
} from '../../componentArtifacts/firstPartyPayloadManifest.js';
import { createScpReadyPayloadArchive } from './createScpReadyPayloadArchive.js';
import type { SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';
import { normalizeScpRemotePath } from '../ssh/scpRemotePath.js';

export interface RemoteFirstPartyCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function assertRemoteCommandSucceeded(result: RemoteFirstPartyCommandResult, label: string): void {
  if (!Number.isSafeInteger(result.status) || result.status !== 0) {
    const status = Number.isSafeInteger(result.status) ? String(result.status) : 'unknown';
    throw new Error(`[remote-first-party-install] ${label} failed with status ${status}.`);
  }
}

export interface RemoteFirstPartyInstallDeps {
  resolveRemoteReleaseTarget: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode?: 'app' | 'system';
  }>) => Promise<Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>>;
  runRemoteText: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    remoteCommand: string;
    knownHostsMode?: 'app' | 'system';
  }>) => Promise<RemoteFirstPartyCommandResult>;
  copyLocalDirectoryToRemote: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    localPath: string;
    remotePath: string;
    knownHostsMode?: 'app' | 'system';
  }>) => Promise<void>;
  preparePayload?: (params: Readonly<{
    componentId: FirstPartyComponentId;
    channel: 'stable' | 'preview' | 'publicdev';
    os: 'linux' | 'darwin';
    arch: 'x64' | 'arm64';
    userAgent?: string;
  }>) => Promise<PreparedFirstPartyComponentPayload>;
  now?: () => number;
}

function sanitizeRemotePathSegment(value: string): string {
  const sanitized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  if (sanitized === '.' || sanitized === '..') {
    throw new Error(`[remote-first-party-install] unsafe remote path segment: ${sanitized}`);
  }
  return sanitized || 'payload';
}

function quoteShellSingleArg(value: string): string {
  const raw = String(value ?? '');
  if (raw === '') return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function quoteRemoteShellPath(value: string): string {
  const raw = String(value ?? '');
  if (raw === '$HOME' || raw.startsWith('$HOME/')) {
    return `"${raw}"`;
  }
  return quoteShellSingleArg(raw);
}

function normalizeBootstrapReleaseChannel(raw: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(raw) || 'stable';
}

function normalizeRemoteHomeDir(raw: unknown): string {
  const trimmed = String(raw ?? '').trim();
  const normalized = trimmed || '$HOME/.happier';
  if (normalized === '~') {
    return '$HOME';
  }
  if (normalized.startsWith('~/')) {
    return normalizeRemoteHomeDir(`$HOME${normalized.slice(1)}`);
  }
  if (normalized.startsWith('$HOME')) {
    const rest = normalized.slice('$HOME'.length);
    if (rest && !rest.startsWith('/')) {
      throw new Error(`Unsupported remote home dir: ${normalized}`);
    }
    const segments = rest
      ? rest.slice(1).split('/').filter(Boolean)
      : [];
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)) {
        throw new Error(`Unsupported remote home dir: ${normalized}`);
      }
    }
    return normalized;
  }
  if (normalized.startsWith('/')) {
    const segments = normalized.slice(1).split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)) {
        throw new Error(`Unsupported remote home dir: ${normalized}`);
      }
    }
    return normalized;
  }
  throw new Error(`Unsupported remote home dir: ${normalized}`);
}

export function normalizeRemoteReleaseOs(value: unknown): 'linux' | 'darwin' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('darwin')) return 'darwin';
  if (normalized.includes('linux')) return 'linux';
  throw new Error(`Unsupported remote bootstrap platform: ${normalized || 'unknown'}`);
}

export function normalizeRemoteReleaseArch(value: unknown): 'x64' | 'arm64' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64' || normalized === 'x64') return 'x64';
  if (normalized === 'aarch64' || normalized === 'arm64') return 'arm64';
  throw new Error(`Unsupported remote bootstrap architecture: ${normalized || 'unknown'}`);
}

export function resolveRemoteInstalledFirstPartyBinaryPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  remoteHomeDir?: string;
}>): string {
  const channel = normalizeBootstrapReleaseChannel(params.channel);
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const variant = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel,
  });
  const remoteHomeDir = normalizeRemoteHomeDir(params.remoteHomeDir);
  return `${remoteHomeDir}/${variant.installRootName}/current/${component.binaryRelativePath}`;
}

export async function installRemoteFirstPartyComponent(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  installerBinaryPath?: string;
  remoteHomeDir?: string;
}>, deps: RemoteFirstPartyInstallDeps): Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>> {
  const resolvedDeps = {
    preparePayload: async (payloadParams: Parameters<NonNullable<RemoteFirstPartyInstallDeps['preparePayload']>>[0]) => await prepareFirstPartyComponentPayloadFromGitHubRelease(payloadParams),
    now: () => Date.now(),
    ...deps,
  } satisfies Required<RemoteFirstPartyInstallDeps>;
  const channel = normalizeBootstrapReleaseChannel(params.channel);
  const remoteHomeDir = normalizeRemoteHomeDir(params.remoteHomeDir);
  const target = await resolvedDeps.resolveRemoteReleaseTarget({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
  });
  const prepared = await resolvedDeps.preparePayload({
    componentId: params.componentId,
    channel,
    os: target.os,
    arch: target.arch,
    userAgent: 'happier-bootstrap',
  });

  try {
    const scpReadyPayload = await createScpReadyPayloadArchive(prepared.payloadRoot);
    const component = getFirstPartyComponentCatalogEntry(params.componentId);
    try {
      if (prepared.contentSha256) {
        const approvedSha256 = normalizeFirstPartyPayloadSha256(
          prepared.contentSha256,
          'prepared payload content SHA-256',
        );
        if (approvedSha256 !== scpReadyPayload.manifestSha256) {
          throw new Error('[remote-first-party-install] Prepared payload content does not match its approved SHA-256.');
        }
      }
      const variant = resolveFirstPartyComponentPublicReleaseVariant({
        componentId: params.componentId,
        channel,
      });
      const installAttemptId = resolvedDeps.now();
      const versionSegment = sanitizeRemotePathSegment(prepared.versionId);
      const stageParent = `${remoteHomeDir}/bootstrap-staging/${sanitizeRemotePathSegment(params.componentId)}-${versionSegment}-${installAttemptId}`;
      const stageParentShellPath = quoteRemoteShellPath(stageParent);
      const stageParentForScp = normalizeScpRemotePath(stageParent);
      const stagingResult = await resolvedDeps.runRemoteText({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        remoteCommand: `mkdir -p ${stageParentShellPath}`,
      });
      assertRemoteCommandSucceeded(stagingResult, 'Remote staging command');
      try {
        await resolvedDeps.copyLocalDirectoryToRemote({
          ssh: params.ssh,
          knownHostsMode: params.knownHostsMode,
          localPath: scpReadyPayload.archiveStageRoot,
          remotePath: stageParentForScp,
        });
      } catch (error) {
        await resolvedDeps.runRemoteText({
          ssh: params.ssh,
          knownHostsMode: params.knownHostsMode,
          remoteCommand: `rm -rf ${stageParentShellPath}`,
        }).catch(() => null);
        throw error;
      }

      const remoteArchiveRoot = `${stageParent}/${sanitizeRemotePathSegment(basename(scpReadyPayload.archiveStageRoot))}`;
      const remoteArchivePath = `${remoteArchiveRoot}/${sanitizeRemotePathSegment(scpReadyPayload.archiveFileName)}`;
      const remoteManifestPath = `${remoteArchiveRoot}/${sanitizeRemotePathSegment(scpReadyPayload.manifestFileName)}`;
      const remoteExtractRoot = `${stageParent}/payload-extracted`;
      const remotePayloadRoot = `${remoteExtractRoot}/${sanitizeRemotePathSegment(scpReadyPayload.extractedPayloadDirName)}`;
      const installRoot = `${remoteHomeDir}/${variant.installRootName}`;
      const versionsDir = `${installRoot}/versions`;
      const versionDir = `${versionsDir}/${versionSegment}`;
      const versionManifestPath = `${versionDir}/${FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME}`;
      const currentPath = `${installRoot}/current`;
      const previousPath = `${installRoot}/previous`;
      const binaryPath = `${currentPath}/${component.binaryRelativePath}`;
      const versionBinaryPath = `${versionDir}/${component.binaryRelativePath}`;
      const candidateBinaryPath = `$candidate_dir/${component.binaryRelativePath}`;
      const candidateEntrypointPath = component.nodeEntrypointRelativePath
        ? `$candidate_dir/${component.nodeEntrypointRelativePath}`
        : null;
      const versionEntrypointPath = component.nodeEntrypointRelativePath
        ? `${versionDir}/${component.nodeEntrypointRelativePath}`
        : null;
      const atomicReplaceFlag = target.os === 'darwin' ? '-fh' : '-fT';
      const remoteArchivePathShell = quoteRemoteShellPath(remoteArchivePath);
      const remoteManifestPathShell = quoteRemoteShellPath(remoteManifestPath);
      const remoteExtractRootShell = quoteRemoteShellPath(remoteExtractRoot);
      const remotePayloadContentsShell = quoteRemoteShellPath(`${remotePayloadRoot}/.`);
      const versionsDirShell = quoteRemoteShellPath(versionsDir);
      const versionDirShell = quoteRemoteShellPath(versionDir);
      const versionManifestPathShell = quoteRemoteShellPath(versionManifestPath);
      const currentPathShell = quoteRemoteShellPath(currentPath);
      const previousPathShell = quoteRemoteShellPath(previousPath);
      const binaryPathShell = quoteRemoteShellPath(binaryPath);
      const versionBinaryPathShell = quoteRemoteShellPath(versionBinaryPath);
      const versionEntrypointPathShell = versionEntrypointPath ? quoteRemoteShellPath(versionEntrypointPath) : null;
      const candidateTemplateShell = quoteRemoteShellPath(`${versionsDir}/.${versionSegment}.candidate.XXXXXX`);
      const currentTemplateShell = quoteRemoteShellPath(`${installRoot}/.current-next.XXXXXX`);
      const previousTemplateShell = quoteRemoteShellPath(`${installRoot}/.previous-next.XXXXXX`);
      const expectedManifestSha256Shell = quoteShellSingleArg(scpReadyPayload.manifestSha256);
      const payloadSha256FileCommand = [
        'payload_sha256_file() {',
        'if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk \'{print $1}\';',
        'elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk \'{print $1}\';',
        'else return 127;',
        'fi;',
        '}',
      ].join(' ');
      const verifyPayloadTreeCommand = [
        'verify_payload_tree() {',
        'verify_root="$1";',
        'verify_manifest="$2";',
        'test ! -L "$verify_root";',
        'test -d "$verify_root";',
        'test ! -L "$verify_manifest";',
        'test -f "$verify_manifest";',
        'unsafe_paths="$(find "$verify_root" \\( -type l -o \\( ! -type d ! -type f \\) \\) -print)" || return 1;',
        '[ -z "$unsafe_paths" ] || return 1;',
        'hard_link_paths="$(find "$verify_root" -type f -links +1 -print)" || return 1;',
        '[ -z "$hard_link_paths" ] || return 1;',
        'expected_files=0;',
        'expected_dirs=0;',
        'tab="$(printf \'\\t\')";',
        'while IFS="$tab" read -r kind expected_hash expected_size relative_path; do',
        'case "$kind" in',
        'V) [ "$expected_hash" = 1 ] && [ "$expected_size" = 0 ] && [ "$relative_path" = . ] || return 1 ;;',
        'D) entry_path="$verify_root/$relative_path"; test ! -L "$entry_path"; test -d "$entry_path"; expected_dirs=$((expected_dirs + 1)) ;;',
        'F) case "$expected_hash" in \'\'|*[!a-f0-9]*) return 1 ;; esac; [ "${#expected_hash}" -eq 64 ] || return 1; case "$expected_size" in \'\'|*[!0-9]*) return 1 ;; esac; entry_path="$verify_root/$relative_path"; test ! -L "$entry_path"; test -f "$entry_path"; actual_size="$(wc -c < "$entry_path")" || return 1; [ "$actual_size" -eq "$expected_size" ] || return 1; actual_hash="$(payload_sha256_file "$entry_path")" || return 1; [ "$actual_hash" = "$expected_hash" ] || return 1; expected_files=$((expected_files + 1)) ;;',
        '*) return 1 ;;',
        'esac;',
        'done < "$verify_manifest";',
        'actual_files="$(find "$verify_root" -type f -print | awk \'END {print NR}\')" || return 1;',
        'actual_dirs="$(find "$verify_root" -type d -print | awk \'END {print NR}\')" || return 1;',
        'manifest_extra=0;',
        `if [ "$verify_manifest" = "$verify_root/${FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME}" ]; then manifest_extra=1; fi;`,
        '[ "$actual_files" -eq "$((expected_files + manifest_extra))" ] || return 1;',
        '[ "$actual_dirs" -eq "$((expected_dirs + 1))" ] || return 1;',
        '}',
      ].join(' ');

      try {
        const installResult = await resolvedDeps.runRemoteText({
          ssh: params.ssh,
          knownHostsMode: params.knownHostsMode,
          remoteCommand: [
            'set -eu',
            'candidate_dir=',
            'next_current=',
            'next_previous=',
            `cleanup() { rm -rf ${stageParentShellPath}; if [ -n "$candidate_dir" ]; then rm -rf "$candidate_dir"; fi; if [ -n "$next_current" ]; then rm -f "$next_current"; fi; if [ -n "$next_previous" ]; then rm -f "$next_previous"; fi; }`,
            'trap cleanup EXIT',
            payloadSha256FileCommand,
            verifyPayloadTreeCommand,
            `test ! -L ${remoteManifestPathShell}`,
            `test -f ${remoteManifestPathShell}`,
            `manifest_hard_links="$(find ${remoteManifestPathShell} -type f -links +1 -print)"`,
            'test -z "$manifest_hard_links"',
            `actual_manifest_sha256="$(payload_sha256_file ${remoteManifestPathShell})"`,
            `test "$actual_manifest_sha256" = ${expectedManifestSha256Shell}`,
            `mkdir -p ${versionsDirShell}`,
            `rm -rf ${remoteExtractRootShell}`,
            `mkdir -p ${remoteExtractRootShell}`,
            `tar -xf ${remoteArchivePathShell} -C ${remoteExtractRootShell}`,
            `candidate_dir="$(mktemp -d ${candidateTemplateShell})"`,
            `cp -R ${remotePayloadContentsShell} "$candidate_dir"`,
            'test ! -L "$candidate_dir"',
            'test -d "$candidate_dir"',
            `test ! -L "${candidateBinaryPath}"`,
            `test -f "${candidateBinaryPath}"`,
            ...(candidateEntrypointPath
              ? [`test ! -L "${candidateEntrypointPath}"`, `test -f "${candidateEntrypointPath}"`]
              : []),
            `verify_payload_tree "$candidate_dir" ${remoteManifestPathShell}`,
            `chmod +x "${candidateBinaryPath}"`,
            `cp ${remoteManifestPathShell} "$candidate_dir/${FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME}"`,
            `chmod 0444 "$candidate_dir/${FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME}"`,
            `if [ -L ${versionDirShell} ]; then exit 1; fi`,
            `if [ -e ${versionDirShell} ]; then test -d ${versionDirShell}; test ! -L ${versionManifestPathShell}; test -f ${versionManifestPathShell}; cmp -s ${remoteManifestPathShell} ${versionManifestPathShell}; verify_payload_tree ${versionDirShell} ${versionManifestPathShell}; test ! -L ${versionBinaryPathShell}; test -f ${versionBinaryPathShell};${versionEntrypointPathShell ? ` test ! -L ${versionEntrypointPathShell}; test -f ${versionEntrypointPathShell};` : ''} rm -rf "$candidate_dir"; candidate_dir=; else mv "$candidate_dir" ${versionDirShell}; candidate_dir=; fi`,
            `verify_payload_tree ${versionDirShell} ${versionManifestPathShell}`,
            `test ! -L ${versionBinaryPathShell}`,
            `test -f ${versionBinaryPathShell}`,
            ...(versionEntrypointPathShell
              ? [`test ! -L ${versionEntrypointPathShell}`, `test -f ${versionEntrypointPathShell}`]
              : []),
            `if [ -e ${currentPathShell} ] && [ ! -L ${currentPathShell} ]; then exit 1; fi`,
            'prev=',
            `if [ -L ${currentPathShell} ]; then prev="$(readlink ${currentPathShell} || true)"; fi`,
            `if [ -n "$prev" ] && [ "$prev" != ${versionDirShell} ]; then if [ -e ${previousPathShell} ] && [ ! -L ${previousPathShell} ]; then exit 1; fi; next_previous="$(mktemp ${previousTemplateShell})"; rm -f "$next_previous"; ln -s "$prev" "$next_previous"; mv ${atomicReplaceFlag} "$next_previous" ${previousPathShell}; next_previous=; fi`,
            `next_current="$(mktemp ${currentTemplateShell})"`,
            'rm -f "$next_current"',
            `ln -s ${versionDirShell} "$next_current"`,
            `mv ${atomicReplaceFlag} "$next_current" ${currentPathShell}`,
            'next_current=',
            `test -x ${binaryPathShell}`,
          ].join('; '),
        });
        assertRemoteCommandSucceeded(installResult, 'Remote install command');
      } catch (error) {
        await resolvedDeps.runRemoteText({
          ssh: params.ssh,
          knownHostsMode: params.knownHostsMode,
          remoteCommand: `rm -rf ${stageParentShellPath}`,
        }).catch(() => null);
        throw error;
      }
    } finally {
      await scpReadyPayload.cleanup();
    }

    return {
      binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({ componentId: params.componentId, channel: params.channel, remoteHomeDir }),
      versionId: prepared.versionId,
      source: prepared.source,
    };
  } finally {
    await prepared.cleanup();
  }
}
