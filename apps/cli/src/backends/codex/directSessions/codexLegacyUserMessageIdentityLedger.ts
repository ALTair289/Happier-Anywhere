import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readPendingLocalId } from '@happier-dev/protocol';

import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';

export type CodexLegacyUserMessageIdentityRecord = Readonly<{
  v: 2;
  attemptId: string;
  ownerId: string;
  threadId: string;
  pendingLocalId: string;
  promptSha256: string;
  fileRelPath: string;
  offsetBytes: number;
  recordedAtMs: number;
  committedAtMs: number;
}>;

type PendingLifecycleRecord = Omit<CodexLegacyUserMessageIdentityRecord, 'committedAtMs'> & Readonly<{
  kind: 'pending';
}>;

type TerminalLifecycleRecord = Readonly<{
  v: 2;
  kind: 'committed' | 'cancelled';
  attemptId: string;
  ownerId: string;
  threadId: string;
  recordedAtMs: number;
}>;

export type CodexLegacyUserMessageIdentityAttempt = Readonly<{
  attemptId: string;
  commit: () => Promise<void>;
  cancel: () => Promise<void>;
}>;

const legacyIdentityQueueTailByBackendSession = new Map<string, Promise<void>>();
const MAX_IN_MEMORY_ACCEPTED_RECOVERY_RECORDS = 256;
const acceptedRecoveryFallbackByKey = new Map<string, Readonly<{
  ledgerPath: string;
  record: CodexLegacyUserMessageIdentityRecord;
}>>();

function lifecycleRecordKey(record: Readonly<{ ownerId: string; attemptId: string }>): string {
  return `${record.ownerId}:${record.attemptId}`;
}

function fallbackRecordKey(path: string, record: Readonly<{ ownerId: string; attemptId: string }>): string {
  return JSON.stringify([path, record.ownerId, record.attemptId]);
}

function retainAcceptedRecoveryRecord(
  path: string,
  pending: PendingLifecycleRecord,
  committedAtMs: number,
): void {
  const record: CodexLegacyUserMessageIdentityRecord = {
    v: 2,
    attemptId: pending.attemptId,
    ownerId: pending.ownerId,
    threadId: pending.threadId,
    pendingLocalId: pending.pendingLocalId,
    promptSha256: pending.promptSha256,
    fileRelPath: pending.fileRelPath,
    offsetBytes: pending.offsetBytes,
    recordedAtMs: pending.recordedAtMs,
    committedAtMs,
  };
  const key = fallbackRecordKey(path, record);
  acceptedRecoveryFallbackByKey.delete(key);
  acceptedRecoveryFallbackByKey.set(key, { ledgerPath: path, record });
  while (acceptedRecoveryFallbackByKey.size > MAX_IN_MEMORY_ACCEPTED_RECOVERY_RECORDS) {
    const oldestKey = acceptedRecoveryFallbackByKey.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    acceptedRecoveryFallbackByKey.delete(oldestKey);
  }
}

function clearAcceptedRecoveryRecord(path: string, record: Readonly<{ ownerId: string; attemptId: string }>): void {
  acceptedRecoveryFallbackByKey.delete(fallbackRecordKey(path, record));
}

function readAcceptedRecoveryFallbackRecords(path: string): CodexLegacyUserMessageIdentityRecord[] {
  return [...acceptedRecoveryFallbackByKey.values()]
    .filter((entry) => entry.ledgerPath === path)
    .map((entry) => entry.record);
}

async function runInLegacyIdentityBackendSessionQueue<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = legacyIdentityQueueTailByBackendSession.get(key) ?? Promise.resolve();
  const acquired = previous.catch(() => {});
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = acquired.then(() => held);
  legacyIdentityQueueTailByBackendSession.set(key, tail);
  await acquired;
  try {
    return await task();
  } finally {
    release();
    if (legacyIdentityQueueTailByBackendSession.get(key) === tail) {
      legacyIdentityQueueTailByBackendSession.delete(key);
    }
  }
}

function ledgerIdentityKey(codexHome: string, threadId: string): string {
  return createHash('sha256').update(codexHome).update('\0').update(threadId).digest('hex');
}

function ledgerFilePath(activeServerDir: string, codexHome: string, threadId: string): string {
  const key = ledgerIdentityKey(codexHome, threadId);
  return join(activeServerDir, 'daemon', 'direct-sessions', 'codex-legacy-user-message-identities-v2', `${key}.jsonl`);
}

function acceptedRecoveryDirectoryPath(activeServerDir: string, codexHome: string, threadId: string): string {
  const key = ledgerIdentityKey(codexHome, threadId);
  return join(activeServerDir, 'daemon', 'direct-sessions', 'codex-legacy-user-message-identities-v2-recovery', key);
}

function acceptedRecoveryFileName(record: Readonly<{ ownerId: string; attemptId: string }>): string {
  const key = createHash('sha256')
    .update(record.ownerId)
    .update('\0')
    .update(record.attemptId)
    .digest('hex');
  return `${key}.json`;
}

export function hashCodexLegacyUserMessagePrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

async function appendLifecycleRecord(path: string, record: PendingLifecycleRecord | TerminalLifecycleRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function acceptedRecordFromPending(
  pending: PendingLifecycleRecord,
  committedAtMs: number,
): CodexLegacyUserMessageIdentityRecord {
  return {
    v: 2,
    attemptId: pending.attemptId,
    ownerId: pending.ownerId,
    threadId: pending.threadId,
    pendingLocalId: pending.pendingLocalId,
    promptSha256: pending.promptSha256,
    fileRelPath: pending.fileRelPath,
    offsetBytes: pending.offsetBytes,
    recordedAtMs: pending.recordedAtMs,
    committedAtMs,
  };
}

async function persistAcceptedRecoveryRecord(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
  record: CodexLegacyUserMessageIdentityRecord;
}>): Promise<void> {
  const recoveryDir = acceptedRecoveryDirectoryPath(params.activeServerDir, params.codexHome, params.threadId);
  await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  await chmod(recoveryDir, 0o700);
  const finalPath = join(recoveryDir, acceptedRecoveryFileName(params.record));
  const temporaryPath = join(recoveryDir, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(params.record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, finalPath);
    const directoryHandle = await open(recoveryDir, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function beginCodexLegacyUserMessageIdentityAttempt(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
  ownerId: string;
  prompt: string;
  pendingLocalId: string;
}>): Promise<CodexLegacyUserMessageIdentityAttempt> {
  const pendingLocalId = readPendingLocalId(params.pendingLocalId);
  if (pendingLocalId === null) throw new Error('Codex legacy user identity requires a valid pending local id');
  if (!params.ownerId) throw new Error('Codex legacy user identity requires an owner id');
  const files = await collectCodexSessionRolloutFiles({
    codexHome: params.codexHome,
    remoteSessionId: params.threadId,
  });
  const target = files.at(-1);
  if (!target) throw new Error('Codex legacy user identity requires an existing rollout file');
  const offsetBytes = await stat(target.filePath).then((value) => Math.max(0, Math.trunc(value.size)));
  const attemptId = randomUUID();
  const path = ledgerFilePath(params.activeServerDir, params.codexHome, params.threadId);
  await reconcileAcceptedRecoveryRecords({
    activeServerDir: params.activeServerDir,
    codexHome: params.codexHome,
    threadId: params.threadId,
    ledgerPath: path,
  }).catch(() => {});
  const pending: PendingLifecycleRecord = {
    v: 2,
    kind: 'pending',
    attemptId,
    ownerId: params.ownerId,
    threadId: params.threadId,
    pendingLocalId,
    promptSha256: hashCodexLegacyUserMessagePrompt(params.prompt),
    fileRelPath: target.fileRelPath,
    offsetBytes,
    recordedAtMs: Date.now(),
  };
  await appendLifecycleRecord(path, pending);

  let terminalState: TerminalLifecycleRecord['kind'] | null = null;
  const finish = async (kind: TerminalLifecycleRecord['kind']) => {
    if (terminalState !== null) {
      if (terminalState !== kind) throw new Error(`Codex legacy identity attempt already ${terminalState}`);
      return;
    }
    const recordedAtMs = Date.now();
    try {
      await appendLifecycleRecord(path, {
        v: 2,
        kind,
        attemptId,
        ownerId: params.ownerId,
        threadId: params.threadId,
        recordedAtMs,
      });
    } catch (error) {
      if (kind !== 'committed') throw error;
      // The provider has already accepted the request when commit() is called. Keep
      // that delivery successful and atomically persist exact reconciliation evidence
      // outside the primary ledger instead of exposing a retryable failure.
      const acceptedRecord = acceptedRecordFromPending(pending, recordedAtMs);
      try {
        await persistAcceptedRecoveryRecord({
          activeServerDir: params.activeServerDir,
          codexHome: params.codexHome,
          threadId: params.threadId,
          record: acceptedRecord,
        });
        clearAcceptedRecoveryRecord(path, pending);
      } catch {
        // Storage can fail after provider acceptance. Preserve success semantics and
        // keep a bounded process-local fallback for the current daemon lifetime.
        retainAcceptedRecoveryRecord(path, pending, recordedAtMs);
      }
      terminalState = kind;
      return;
    }
    clearAcceptedRecoveryRecord(path, pending);
    terminalState = kind;
  };
  return {
    attemptId,
    commit: async () => await finish('committed'),
    cancel: async () => await finish('cancelled'),
  };
}

export async function runCodexLegacyUserMessageIdentityAttempt<T>(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
  ownerId: string;
  prompt: string;
  pendingLocalId: string;
  request: () => Promise<T>;
}>): Promise<T> {
  const queueKey = JSON.stringify([params.activeServerDir, params.codexHome, params.threadId]);
  return await runInLegacyIdentityBackendSessionQueue(queueKey, async () => {
    const attempt = await beginCodexLegacyUserMessageIdentityAttempt(params);
    try {
      const result = await params.request();
      await attempt.commit();
      return result;
    } catch (error) {
      await attempt.cancel().catch(() => {});
      throw error;
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readCommonLifecycleFields(record: Record<string, unknown>): Readonly<{
  attemptId: string;
  ownerId: string;
  threadId: string;
  recordedAtMs: number;
}> | null {
  if (
    record.v !== 2
    || typeof record.attemptId !== 'string'
    || !record.attemptId
    || typeof record.ownerId !== 'string'
    || !record.ownerId
    || typeof record.threadId !== 'string'
    || !record.threadId
    || typeof record.recordedAtMs !== 'number'
    || !Number.isSafeInteger(record.recordedAtMs)
    || record.recordedAtMs < 0
  ) return null;
  return {
    attemptId: record.attemptId,
    ownerId: record.ownerId,
    threadId: record.threadId,
    recordedAtMs: record.recordedAtMs,
  };
}

function parsePendingRecord(value: unknown): PendingLifecycleRecord | null {
  const record = asRecord(value);
  if (!record || record.kind !== 'pending') return null;
  const common = readCommonLifecycleFields(record);
  const pendingLocalId = readPendingLocalId(record.pendingLocalId);
  if (
    !common
    || pendingLocalId === null
    || typeof record.promptSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.promptSha256)
    || typeof record.fileRelPath !== 'string'
    || !record.fileRelPath
    || typeof record.offsetBytes !== 'number'
    || !Number.isSafeInteger(record.offsetBytes)
    || record.offsetBytes < 0
  ) return null;
  return {
    v: 2,
    kind: 'pending',
    ...common,
    pendingLocalId,
    promptSha256: record.promptSha256,
    fileRelPath: record.fileRelPath,
    offsetBytes: record.offsetBytes,
  };
}

function parseTerminalRecord(value: unknown): TerminalLifecycleRecord | null {
  const record = asRecord(value);
  if (!record || (record.kind !== 'committed' && record.kind !== 'cancelled')) return null;
  const common = readCommonLifecycleFields(record);
  return common ? { v: 2, kind: record.kind, ...common } : null;
}

function parseAcceptedRecoveryRecord(value: unknown): CodexLegacyUserMessageIdentityRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const pending = parsePendingRecord({ ...record, kind: 'pending' });
  if (
    !pending
    || typeof record.committedAtMs !== 'number'
    || !Number.isSafeInteger(record.committedAtMs)
    || record.committedAtMs < pending.recordedAtMs
  ) return null;
  return acceptedRecordFromPending(pending, record.committedAtMs);
}

function parseCommittedRecordsFromRaw(raw: string, threadId: string): CodexLegacyUserMessageIdentityRecord[] {
  const pendingByKey = new Map<string, PendingLifecycleRecord>();
  const terminalKindsByKey = new Map<string, Set<TerminalLifecycleRecord['kind']>>();
  const terminalAtByKey = new Map<string, number>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const pending = parsePendingRecord(value);
    if (pending && pending.threadId === threadId) {
      pendingByKey.set(lifecycleRecordKey(pending), pending);
      continue;
    }
    const terminal = parseTerminalRecord(value);
    if (!terminal || terminal.threadId !== threadId) continue;
    const key = lifecycleRecordKey(terminal);
    const kinds = terminalKindsByKey.get(key) ?? new Set<TerminalLifecycleRecord['kind']>();
    kinds.add(terminal.kind);
    terminalKindsByKey.set(key, kinds);
    terminalAtByKey.set(key, Math.max(terminalAtByKey.get(key) ?? 0, terminal.recordedAtMs));
  }

  return [...pendingByKey.entries()].flatMap(([key, pending]) => {
    const kinds = terminalKindsByKey.get(key);
    if (!kinds || kinds.size !== 1 || !kinds.has('committed')) return [];
    return [acceptedRecordFromPending(
      pending,
      terminalAtByKey.get(key) ?? pending.recordedAtMs,
    )];
  });
}

async function readAcceptedRecoveryFiles(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
}>): Promise<ReadonlyArray<Readonly<{
  filePath: string;
  record: CodexLegacyUserMessageIdentityRecord;
}>>> {
  const recoveryDir = acceptedRecoveryDirectoryPath(params.activeServerDir, params.codexHome, params.threadId);
  const entries = await readdir(recoveryDir, { withFileTypes: true }).catch(() => []);
  const recovered: Array<Readonly<{ filePath: string; record: CodexLegacyUserMessageIdentityRecord }>> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const filePath = join(recoveryDir, entry.name);
    const raw = await readFile(filePath, 'utf8').catch(() => '');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    const record = parseAcceptedRecoveryRecord(value);
    if (
      !record
      || record.threadId !== params.threadId
      || entry.name !== acceptedRecoveryFileName(record)
    ) continue;
    recovered.push({ filePath, record });
  }
  return recovered;
}

async function reconcileAcceptedRecoveryRecords(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
  ledgerPath: string;
}>): Promise<void> {
  const raw = await readFile(params.ledgerPath, 'utf8').catch(() => '');
  const committedKeys = new Set(
    parseCommittedRecordsFromRaw(raw, params.threadId).map((record) => lifecycleRecordKey(record)),
  );
  const recoveredByKey = new Map<string, Readonly<{
    filePath?: string;
    record: CodexLegacyUserMessageIdentityRecord;
  }>>();
  for (const recovered of await readAcceptedRecoveryFiles(params)) {
    recoveredByKey.set(lifecycleRecordKey(recovered.record), recovered);
  }
  for (const record of readAcceptedRecoveryFallbackRecords(params.ledgerPath)) {
    const key = lifecycleRecordKey(record);
    if (!recoveredByKey.has(key)) recoveredByKey.set(key, { record });
  }

  for (const [key, recovered] of recoveredByKey) {
    if (!committedKeys.has(key)) {
      const pending: PendingLifecycleRecord = {
        v: 2,
        kind: 'pending',
        attemptId: recovered.record.attemptId,
        ownerId: recovered.record.ownerId,
        threadId: recovered.record.threadId,
        pendingLocalId: recovered.record.pendingLocalId,
        promptSha256: recovered.record.promptSha256,
        fileRelPath: recovered.record.fileRelPath,
        offsetBytes: recovered.record.offsetBytes,
        recordedAtMs: recovered.record.recordedAtMs,
      };
      const terminal: TerminalLifecycleRecord = {
        v: 2,
        kind: 'committed',
        attemptId: recovered.record.attemptId,
        ownerId: recovered.record.ownerId,
        threadId: recovered.record.threadId,
        recordedAtMs: recovered.record.committedAtMs,
      };
      await mkdir(dirname(params.ledgerPath), { recursive: true });
      await appendFile(
        params.ledgerPath,
        `${JSON.stringify(pending)}\n${JSON.stringify(terminal)}\n`,
        'utf8',
      );
      committedKeys.add(key);
    }
    if (recovered.filePath) {
      await rm(recovered.filePath, { force: true }).catch(() => {});
    }
    clearAcceptedRecoveryRecord(params.ledgerPath, recovered.record);
  }
}

export async function readCodexLegacyUserMessageIdentityRecords(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
}>): Promise<readonly CodexLegacyUserMessageIdentityRecord[]> {
  const path = ledgerFilePath(params.activeServerDir, params.codexHome, params.threadId);
  const raw = await readFile(path, 'utf8').catch(() => '');
  const committed = parseCommittedRecordsFromRaw(raw, params.threadId);
  const recovered = [
    ...(await readAcceptedRecoveryFiles(params)).map((entry) => entry.record),
    ...readAcceptedRecoveryFallbackRecords(path),
  ].filter((record) => record.threadId === params.threadId);
  const recordsByKey = new Map<string, CodexLegacyUserMessageIdentityRecord>();
  for (const record of [...committed, ...recovered]) recordsByKey.set(lifecycleRecordKey(record), record);
  return [...recordsByKey.values()]
    .sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.attemptId.localeCompare(right.attemptId));
}
