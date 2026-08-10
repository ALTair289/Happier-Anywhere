import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
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

function ledgerFilePath(activeServerDir: string, codexHome: string, threadId: string): string {
  const key = createHash('sha256').update(codexHome).update('\0').update(threadId).digest('hex');
  return join(activeServerDir, 'daemon', 'direct-sessions', 'codex-legacy-user-message-identities-v2', `${key}.jsonl`);
}

export function hashCodexLegacyUserMessagePrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

async function appendLifecycleRecord(path: string, record: PendingLifecycleRecord | TerminalLifecycleRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
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
    await appendLifecycleRecord(path, {
      v: 2,
      kind,
      attemptId,
      ownerId: params.ownerId,
      threadId: params.threadId,
      recordedAtMs: Date.now(),
    });
    terminalState = kind;
  };
  return {
    attemptId,
    commit: async () => await finish('committed'),
    cancel: async () => await finish('cancelled'),
  };
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

export async function readCodexLegacyUserMessageIdentityRecords(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
}>): Promise<readonly CodexLegacyUserMessageIdentityRecord[]> {
  const path = ledgerFilePath(params.activeServerDir, params.codexHome, params.threadId);
  const raw = await readFile(path, 'utf8').catch(() => '');
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
    if (pending && pending.threadId === params.threadId) {
      pendingByKey.set(`${pending.ownerId}:${pending.attemptId}`, pending);
      continue;
    }
    const terminal = parseTerminalRecord(value);
    if (!terminal || terminal.threadId !== params.threadId) continue;
    const key = `${terminal.ownerId}:${terminal.attemptId}`;
    const kinds = terminalKindsByKey.get(key) ?? new Set<TerminalLifecycleRecord['kind']>();
    kinds.add(terminal.kind);
    terminalKindsByKey.set(key, kinds);
    terminalAtByKey.set(key, Math.max(terminalAtByKey.get(key) ?? 0, terminal.recordedAtMs));
  }

  return [...pendingByKey.entries()]
    .flatMap(([key, pending]) => {
      const kinds = terminalKindsByKey.get(key);
      if (!kinds || kinds.size !== 1 || !kinds.has('committed')) return [];
      return [{
        v: 2,
        attemptId: pending.attemptId,
        ownerId: pending.ownerId,
        threadId: pending.threadId,
        pendingLocalId: pending.pendingLocalId,
        promptSha256: pending.promptSha256,
        fileRelPath: pending.fileRelPath,
        offsetBytes: pending.offsetBytes,
        recordedAtMs: pending.recordedAtMs,
        committedAtMs: terminalAtByKey.get(key) ?? pending.recordedAtMs,
      } satisfies CodexLegacyUserMessageIdentityRecord];
    })
    .sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.attemptId.localeCompare(right.attemptId));
}
