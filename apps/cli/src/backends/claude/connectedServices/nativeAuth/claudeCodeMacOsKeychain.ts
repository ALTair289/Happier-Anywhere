import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { logger } from '@/ui/logger';

import {
  buildSafeClaudeCodeCredentialComparatorEntry,
  computeClaudeCodeCredentialFingerprint,
  isExistingClaudeCodeCredentialNewer,
  readClaudeCodeCredentialFreshness,
  readClaudeCodeNativeCredentialPayload,
  type ClaudeCodeNativeCredentialPayload,
} from './claudeCodeNativeCredentialPayload';

const DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const HAPPIER_MANAGED_CLAUDE_CODE_KEYCHAIN_SERVICE_PATTERN = /^Claude Code-credentials-[a-f0-9]{8}$/;
const KEYCHAIN_TIMESTAMP_PATTERN = /"mdat"<timedate>=[^\n"]*"(\d{14})Z\\000"/;
const CLAUDE_CODE_KEYCHAIN_SECURITY_TIMEOUT_MS = 10_000;

export type ClaudeCodeMacOsKeychainCredentialReadResult = Readonly<{
  payload: ClaudeCodeNativeCredentialPayload;
  updatedAtMs: number | null;
}>;

export type ClaudeCodeMacOsKeychainCredentialWriteProvenance = Readonly<{
  credentialFingerprint: string;
  writtenAtMs: number;
}>;

export type ClaudeCodeMacOsKeychainCredentialWriteResult =
  | Readonly<{
      status: 'written';
      adoptedCredential: null;
      credentialFingerprint: string;
      writtenAtMs: number;
    }>
  | Readonly<{
      status: 'skipped_provenance_match';
      adoptedCredential: null;
      credentialFingerprint: string;
      writtenAtMs: number;
    }>
  | Readonly<{
      status: 'skipped_existing_newer';
      adoptedCredential: Readonly<{
        payload: ClaudeCodeNativeCredentialPayload;
        updatedAtMs: number;
      }>;
    }>;

export type ClaudeCodeMacOsKeychainSweepSkipReason =
  | 'global_service'
  | 'live_service'
  | 'different_account'
  | 'not_happier_managed_service'
  | 'unverifiable_live_set';

export type ClaudeCodeMacOsKeychainSweepEntry = Readonly<{
  account: string;
  service: string;
}>;

export type ClaudeCodeMacOsKeychainSweepSkippedEntry =
  ClaudeCodeMacOsKeychainSweepEntry & Readonly<{
    reason: ClaudeCodeMacOsKeychainSweepSkipReason;
  }>;

export type ClaudeCodeMacOsKeychainSweepResult = Readonly<{
  scanned: number;
  deleted: readonly ClaudeCodeMacOsKeychainSweepEntry[];
  skipped: readonly ClaudeCodeMacOsKeychainSweepSkippedEntry[];
}>;

type ClaudeCodeMacOsKeychainCredentialDiagnosticContext = Readonly<{
  profileId?: string | undefined;
  homeKind?: 'profile' | 'group' | string | undefined;
}>;

function resolveDefaultClaudeConfigDir(homeDir: string): string {
  return resolve(join(homeDir, '.claude'));
}

export function resolveClaudeCodeMacOsKeychainServiceName(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
}>): string {
  const resolvedClaudeConfigDir = resolve(params.claudeConfigDir);
  const resolvedHomeDir = resolve(String(params.homeDir ?? homedir()));
  if (resolvedClaudeConfigDir === resolveDefaultClaudeConfigDir(resolvedHomeDir)) {
    return DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE;
  }
  const suffix = createHash('sha256').update(resolvedClaudeConfigDir).digest('hex').slice(0, 8);
  return `${DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE}-${suffix}`;
}

export function isClaudeCodeMacOsGlobalKeychainService(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
}>): boolean {
  return resolveClaudeCodeMacOsKeychainServiceName(params) === DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE;
}

function buildKeychainPayloadInput(payload: ClaudeCodeNativeCredentialPayload): string {
  const serialized = JSON.stringify(payload);
  // The macOS security CLI prompts for both the secret and a confirmation retype
  // when using `-w` interactively; piping the value twice keeps the write stable
  // in non-interactive agent execution as well.
  return `${serialized}\n${serialized}\n`;
}

function stripClaudeCodeMacOsKeychainRefreshToken(
  payload: ClaudeCodeNativeCredentialPayload,
): ClaudeCodeNativeCredentialPayload {
  const { refreshToken: _refreshToken, ...credential } = payload.claudeAiOauth;
  return {
    claudeAiOauth: credential,
  };
}

function buildKeychainWriteError(stderr: string, status: number | null): Error {
  const detail = stderr.trim();
  return new Error(
    detail.length > 0
      ? `claude_code_keychain_write_failed:${detail}`
      : `claude_code_keychain_write_failed:status_${status ?? 'unknown'}`,
  );
}

function buildKeychainTimeoutError(): Error {
  return new Error('claude_code_keychain_write_failed:security_timeout');
}

async function runSecurityCommand(params: Readonly<{
  args: readonly string[];
  input?: string | undefined;
  timeoutMs?: number | undefined;
}>): Promise<Readonly<{ stdout: string; stderr: string; status: number | null }>> {
  const child = spawn('security', [...params.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
    ? Math.max(1, Math.trunc(params.timeoutMs))
    : CLAUDE_CODE_KEYCHAIN_SECURITY_TIMEOUT_MS;

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(buildKeychainTimeoutError());
    }, timeoutMs);
    timeout.unref?.();

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout?.on('data', (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.once('error', (error) => {
      settle(() => reject(error));
    });
    child.once('close', (status) => {
      settle(() => resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        status,
      }));
    });
    if (params.input !== undefined) {
      child.stdin?.end(params.input);
    } else {
      child.stdin?.end();
    }
  });
}

function resolveKeychainUsername(username?: string | null | undefined): string {
  return String(username ?? userInfo().username).trim();
}

function parseDumpedKeychainCredentialEntries(output: string): ClaudeCodeMacOsKeychainSweepEntry[] {
  const entries: ClaudeCodeMacOsKeychainSweepEntry[] = [];
  for (const block of output.split(/\n(?=keychain: )/)) {
    const account = /"acct"<blob>="([^"]+)"/.exec(block)?.[1]?.trim();
    const service = /"svce"<blob>="([^"]+)"/.exec(block)?.[1]?.trim();
    if (!account || !service) continue;
    entries.push({ account, service });
  }
  return entries;
}

function classifyKeychainSweepEntry(params: Readonly<{
  entry: ClaudeCodeMacOsKeychainSweepEntry;
  username: string;
  liveServices: ReadonlySet<string>;
  liveSetVerifiable: boolean;
}>): ClaudeCodeMacOsKeychainSweepSkipReason | 'delete' {
  if (params.entry.account !== params.username) return 'different_account';
  if (params.entry.service === DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE) return 'global_service';
  if (!HAPPIER_MANAGED_CLAUDE_CODE_KEYCHAIN_SERVICE_PATTERN.test(params.entry.service)) {
    return 'not_happier_managed_service';
  }
  if (params.liveServices.has(params.entry.service)) return 'live_service';
  // Fail closed: with no verifiable live set we cannot positively identify a managed item as stale, so
  // we must never delete it — an incomplete live-set discovery must not evict a live sibling's item.
  if (!params.liveSetVerifiable) return 'unverifiable_live_set';
  return 'delete';
}

function parseKeychainTimestamp(metadata: string): number | null {
  const match = KEYCHAIN_TIMESTAMP_PATTERN.exec(metadata);
  const value = match?.[1];
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function logKeychainCredentialDecision(params: Readonly<{
  decision: 'write' | 'skip_existing_newer' | 'skip_provenance_match';
  diagnosticContext?: ClaudeCodeMacOsKeychainCredentialDiagnosticContext | undefined;
  existing: ClaudeCodeMacOsKeychainCredentialReadResult | null;
  incomingPayload: ClaudeCodeNativeCredentialPayload;
  incomingUpdatedAtMs: number;
  provenanceBasis: Readonly<{
    incomingMatchesLastWritten: boolean;
    newerExternalChangeDetected: boolean;
  }>;
}>): void {
  const existingFreshness = params.existing
    ? readClaudeCodeCredentialFreshness(
        params.existing.payload,
        params.existing.updatedAtMs ?? Date.now(),
      )
    : null;
  const incomingFreshness = readClaudeCodeCredentialFreshness(
    params.incomingPayload,
    params.incomingUpdatedAtMs,
  );
  logger.info('[DAEMON RUN] Claude Code keychain credential decision', {
    event: 'claude_code_keychain_credential_decision',
    ...(params.diagnosticContext ?? {}),
    decision: params.decision,
    comparatorBasis: {
      existing: params.existing && existingFreshness
        ? buildSafeClaudeCodeCredentialComparatorEntry(
            params.existing.payload,
            existingFreshness,
            'macos_keychain',
          )
        : null,
      incoming: buildSafeClaudeCodeCredentialComparatorEntry(
        params.incomingPayload,
        incomingFreshness,
        'incoming',
      ),
      sameRefreshToken: existingFreshness
        ? existingFreshness.refreshToken === incomingFreshness.refreshToken
        : null,
    },
    provenanceBasis: params.provenanceBasis,
    decidedAtMs: Date.now(),
  });
}

export async function writeClaudeCodeMacOsKeychainCredential(params: Readonly<{
  claudeConfigDir: string;
  payload: ClaudeCodeNativeCredentialPayload;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
  incomingUpdatedAtMs?: number | undefined;
  preserveNewerExistingCredential?: boolean | undefined;
  /**
   * The daemon's own record of what it last wrote into this keychain item (fingerprint + when).
   * This is the AUTHORITATIVE comparator basis because the shared group keychain item is frequently
   * ACL-unreadable (`security` non-zero exit == null == "absent"), so a read-based comparator can
   * never skip and every spawn/resume blind-rewrites the item, evicting running sibling processes.
   * When the incoming payload fingerprint matches this record we skip the write entirely.
   */
  lastWrittenProvenance?: ClaudeCodeMacOsKeychainCredentialWriteProvenance | undefined;
  diagnosticContext?: ClaudeCodeMacOsKeychainCredentialDiagnosticContext | undefined;
}>): Promise<ClaudeCodeMacOsKeychainCredentialWriteResult> {
  const payload = stripClaudeCodeMacOsKeychainRefreshToken(params.payload);
  const incomingUpdatedAtMs = typeof params.incomingUpdatedAtMs === 'number' && Number.isFinite(params.incomingUpdatedAtMs)
    ? params.incomingUpdatedAtMs
    : Date.now();
  const incomingFingerprint = computeClaudeCodeCredentialFingerprint(payload);
  const existing = await readClaudeCodeMacOsKeychainCredentialWithMetadata({
    claudeConfigDir: params.claudeConfigDir,
    homeDir: params.homeDir,
    username: params.username,
  });
  const incomingMatchesLastWritten =
    params.lastWrittenProvenance?.credentialFingerprint === incomingFingerprint;
  // A readable keychain item that DIFFERS from what we last wrote AND is newer than our last write is
  // an external mutation (e.g. the user ran `/login`, creating a keychain shadow). In that case we must
  // NOT skip on a provenance match — fall through so the normal freshness comparator can preserve it.
  const newerExternalChangeDetected = Boolean(
    existing
    && params.lastWrittenProvenance
    && computeClaudeCodeCredentialFingerprint(stripClaudeCodeMacOsKeychainRefreshToken(existing.payload))
      !== params.lastWrittenProvenance.credentialFingerprint
    && (existing.updatedAtMs ?? 0) > params.lastWrittenProvenance.writtenAtMs,
  );
  const provenanceBasis = { incomingMatchesLastWritten, newerExternalChangeDetected } as const;
  if (params.lastWrittenProvenance && incomingMatchesLastWritten && !newerExternalChangeDetected) {
    logKeychainCredentialDecision({
      decision: 'skip_provenance_match',
      diagnosticContext: params.diagnosticContext,
      existing,
      incomingPayload: payload,
      incomingUpdatedAtMs,
      provenanceBasis,
    });
    return {
      status: 'skipped_provenance_match',
      adoptedCredential: null,
      credentialFingerprint: incomingFingerprint,
      writtenAtMs: params.lastWrittenProvenance.writtenAtMs,
    };
  }
  if (existing && params.preserveNewerExistingCredential !== false) {
    const existingUpdatedAtMs = existing.updatedAtMs ?? Date.now();
    const existingFreshness = readClaudeCodeCredentialFreshness(existing.payload, existingUpdatedAtMs);
    const incomingFreshness = readClaudeCodeCredentialFreshness(payload, incomingUpdatedAtMs);
    if (isExistingClaudeCodeCredentialNewer({ existing: existingFreshness, incoming: incomingFreshness })) {
      logKeychainCredentialDecision({
        decision: 'skip_existing_newer',
        diagnosticContext: params.diagnosticContext,
        existing,
        incomingPayload: payload,
        incomingUpdatedAtMs,
        provenanceBasis,
      });
      return {
        status: 'skipped_existing_newer',
        adoptedCredential: {
          payload: existing.payload,
          updatedAtMs: existingUpdatedAtMs,
        },
      };
    }
  }

  logKeychainCredentialDecision({
    decision: 'write',
    diagnosticContext: params.diagnosticContext,
    existing,
    incomingPayload: payload,
    incomingUpdatedAtMs,
    provenanceBasis,
  });
  const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
    claudeConfigDir: params.claudeConfigDir,
    homeDir: params.homeDir,
  });
  const username = resolveKeychainUsername(params.username);
  const writtenAtMs = Date.now();
  const result = await runSecurityCommand({
    args: ['add-generic-password', '-U', '-a', username, '-s', serviceName, '-w'],
    input: buildKeychainPayloadInput(payload),
  });
  if (result.status !== 0) {
    throw buildKeychainWriteError(String(result.stderr ?? ''), result.status);
  }
  return {
    status: 'written',
    adoptedCredential: null,
    credentialFingerprint: incomingFingerprint,
    writtenAtMs,
  };
}

export async function deleteClaudeCodeMacOsKeychainCredential(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
}>): Promise<void> {
  const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
    claudeConfigDir: params.claudeConfigDir,
    homeDir: params.homeDir,
  });
  const username = resolveKeychainUsername(params.username);
  const result = await runSecurityCommand({
    args: ['delete-generic-password', '-a', username, '-s', serviceName],
  });
  if (result.status !== 0 && !String(result.stderr ?? '').includes('could not be found')) {
    throw buildKeychainWriteError(String(result.stderr ?? ''), result.status);
  }
}

export async function sweepStaleClaudeCodeMacOsKeychainCredentials(params: Readonly<{
  liveClaudeConfigDirs: readonly string[];
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
}>): Promise<ClaudeCodeMacOsKeychainSweepResult> {
  const username = resolveKeychainUsername(params.username);
  const liveServices = new Set(
    params.liveClaudeConfigDirs.map((claudeConfigDir) => resolveClaudeCodeMacOsKeychainServiceName({
      claudeConfigDir,
      homeDir: params.homeDir,
    })),
  );
  const dump = await runSecurityCommand({ args: ['dump-keychain'] });
  if (dump.status !== 0) {
    throw buildKeychainWriteError(String(dump.stderr ?? ''), dump.status);
  }
  const liveSetVerifiable = liveServices.size > 0;
  const entries = parseDumpedKeychainCredentialEntries(dump.stdout);
  const deleted: ClaudeCodeMacOsKeychainSweepEntry[] = [];
  const skipped: ClaudeCodeMacOsKeychainSweepSkippedEntry[] = [];
  for (const entry of entries) {
    const decision = classifyKeychainSweepEntry({ entry, username, liveServices, liveSetVerifiable });
    if (decision !== 'delete') {
      skipped.push({ ...entry, reason: decision });
      continue;
    }
    const result = await runSecurityCommand({
      args: ['delete-generic-password', '-a', entry.account, '-s', entry.service],
    });
    if (result.status === 0) {
      deleted.push(entry);
      continue;
    }
    if (String(result.stderr ?? '').includes('could not be found')) continue;
    throw buildKeychainWriteError(String(result.stderr ?? ''), result.status);
  }
  logger.info('[DAEMON RUN] Claude Code keychain stale credential sweep', {
    event: 'claude_code_keychain_stale_credential_sweep',
    scanned: entries.length,
    deleted,
    skipped,
    decidedAtMs: Date.now(),
  });
  return {
    scanned: entries.length,
    deleted,
    skipped,
  };
}

export async function readClaudeCodeMacOsKeychainCredential(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
}>): Promise<ClaudeCodeNativeCredentialPayload | null> {
  return (await readClaudeCodeMacOsKeychainCredentialWithMetadata(params))?.payload ?? null;
}

export async function readClaudeCodeMacOsKeychainCredentialWithMetadata(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
}>): Promise<ClaudeCodeMacOsKeychainCredentialReadResult | null> {
  const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
    claudeConfigDir: params.claudeConfigDir,
    homeDir: params.homeDir,
  });
  const username = resolveKeychainUsername(params.username);
  try {
    const args = ['find-generic-password', '-a', username, '-s', serviceName] as const;
    const [raw, metadata] = await Promise.all([
      runSecurityCommand({ args: [...args, '-w'] }),
      runSecurityCommand({ args }),
    ]);
    if (raw.status !== 0 || metadata.status !== 0) return null;
    const parsed = JSON.parse(raw.stdout.trim()) as unknown;
    const payload = readClaudeCodeNativeCredentialPayload(parsed);
    return payload
      ? {
          payload,
          updatedAtMs: parseKeychainTimestamp(metadata.stdout),
        }
      : null;
  } catch {
    return null;
  }
}
