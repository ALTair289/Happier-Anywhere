import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readPendingLocalId } from '@happier-dev/protocol';

import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';

export type CodexLegacyUserMessageIdentityRecord = Readonly<{
  v: 1;
  threadId: string;
  pendingLocalId: string;
  promptSha256: string;
  fileRelPath: string;
  offsetBytes: number;
  recordedAtMs: number;
}>;

function ledgerFilePath(activeServerDir: string, codexHome: string, threadId: string): string {
  const key = createHash('sha256').update(codexHome).update('\0').update(threadId).digest('hex');
  return join(activeServerDir, 'daemon', 'direct-sessions', 'codex-legacy-user-message-identities-v1', `${key}.jsonl`);
}

export function hashCodexLegacyUserMessagePrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export async function recordCodexLegacyUserMessageIdentity(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
  prompt: string;
  pendingLocalId: string;
}>): Promise<void> {
  const pendingLocalId = readPendingLocalId(params.pendingLocalId);
  if (pendingLocalId === null) throw new Error('Codex legacy user identity requires a valid pending local id');
  const files = await collectCodexSessionRolloutFiles({
    codexHome: params.codexHome,
    remoteSessionId: params.threadId,
  });
  const target = files.at(-1);
  if (!target) throw new Error('Codex legacy user identity requires an existing rollout file');
  const offsetBytes = await stat(target.filePath).then((value) => Math.max(0, Math.trunc(value.size)));
  const record: CodexLegacyUserMessageIdentityRecord = {
    v: 1,
    threadId: params.threadId,
    pendingLocalId,
    promptSha256: hashCodexLegacyUserMessagePrompt(params.prompt),
    fileRelPath: target.fileRelPath,
    offsetBytes,
    recordedAtMs: Date.now(),
  };
  const path = ledgerFilePath(params.activeServerDir, params.codexHome, params.threadId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function parseRecord(value: unknown): CodexLegacyUserMessageIdentityRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pendingLocalId = readPendingLocalId(record.pendingLocalId);
  if (
    record.v !== 1
    || typeof record.threadId !== 'string'
    || record.threadId.length === 0
    || pendingLocalId === null
    || typeof record.promptSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.promptSha256)
    || typeof record.fileRelPath !== 'string'
    || record.fileRelPath.length === 0
    || typeof record.offsetBytes !== 'number'
    || !Number.isSafeInteger(record.offsetBytes)
    || record.offsetBytes < 0
    || typeof record.recordedAtMs !== 'number'
    || !Number.isSafeInteger(record.recordedAtMs)
    || record.recordedAtMs < 0
  ) return null;
  return {
    v: 1,
    threadId: record.threadId,
    pendingLocalId,
    promptSha256: record.promptSha256,
    fileRelPath: record.fileRelPath,
    offsetBytes: record.offsetBytes,
    recordedAtMs: record.recordedAtMs,
  };
}

export async function readCodexLegacyUserMessageIdentityRecords(params: Readonly<{
  activeServerDir: string;
  codexHome: string;
  threadId: string;
}>): Promise<readonly CodexLegacyUserMessageIdentityRecord[]> {
  const path = ledgerFilePath(params.activeServerDir, params.codexHome, params.threadId);
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = parseRecord(JSON.parse(line));
      return parsed && parsed.threadId === params.threadId ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
