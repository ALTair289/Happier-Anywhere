import type { RawJSONLines } from '../types';
import { parseClaudeQueuedCommandAttachment } from '../attachments/claudeAttachmentTypes';
import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity';

type AcceptedPrompt = Readonly<{
  id: string;
  text: string;
  normalizedText: string;
  deliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null;
  acceptedAtMs: number;
  expiresAtMs: number;
}>;

export type ClaudeUnifiedAcceptedPromptDeliveryIdentity = Readonly<{
  localIds?: readonly string[] | undefined;
  userMessageSeq?: number | null | undefined;
  userMessageSeqs?: readonly number[] | undefined;
}>;

export type ClaudeUnifiedAcceptedPromptTranscriptMatch = Readonly<{
  acceptedPromptId: string;
  acceptedPromptNormalizedText: string;
  deliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null;
  transcriptUuid: string | null;
  transcriptPromptId: string | null;
  transcriptTimestampMs: number | null;
  matchKind: 'exact' | 'command_name';
  transcriptKey: string | null;
}>;

export type ClaudeUnifiedAcceptedPromptTranscriptDiscovery = Readonly<{
  recordAcceptedPrompt(input: Readonly<{
    message: string;
    acceptedAtMs?: number | undefined;
    deliveryIdentity?: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null | undefined;
  }>): void;
  consumeAcceptedPromptByBatch(input: Readonly<{
    message: string;
    maxUserMessageSeq?: number | null | undefined;
    userMessageLocalIds?: readonly string[] | null | undefined;
  }>): boolean;
  findMatchingTranscript(messages: readonly unknown[]): ClaudeUnifiedAcceptedPromptTranscriptMatch | null;
  consumeAcceptedPromptMatch(match: ClaudeUnifiedAcceptedPromptTranscriptMatch): boolean;
  claimMatchingTranscript(messages: readonly unknown[]): ClaudeUnifiedAcceptedPromptTranscriptMatch | null;
  consumeMatchingTranscript(messages: readonly unknown[]): boolean;
}>;

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readMessageTimestampMs(message: unknown): number | null {
  const raw = (message as Record<string, unknown>).timestamp;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCommandNamePromptText(content: string): string | null {
  const match = content.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  const commandName = match?.[1]?.trim();
  return commandName && commandName.startsWith('/') ? commandName : null;
}

function readContentTextParts(content: unknown): readonly string[] {
  if (typeof content === 'string') return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) parts.push(part);
      continue;
    }
    const record = readObject(part);
    const text = record?.text;
    if (typeof text === 'string' && text.length > 0) {
      parts.push(text);
    }
  }
  return parts;
}

function expandPromptText(contentText: string): readonly string[] {
  const commandName = readCommandNamePromptText(contentText);
  return commandName ? [contentText, commandName] : [contentText];
}

function readUserPromptTexts(message: RawJSONLines): readonly string[] {
  if (message.type !== 'user') return [];
  if ((message as Record<string, unknown>).isMeta === true) return [];
  const content = message.message?.content;
  const textParts = readContentTextParts(content);
  if (textParts.length === 0) return [];
  const joinedText = textParts.length > 1 ? textParts.join('') : null;
  const candidates = joinedText && !textParts.includes(joinedText)
    ? [joinedText, ...textParts]
    : textParts;
  return candidates.flatMap(expandPromptText);
}

function readQueuedCommandPromptTexts(value: unknown): readonly string[] {
  const message = readObject(value);
  if (!message) return [];
  if (message.type === 'queue-operation') {
    if (message.operation !== 'enqueue') return [];
    const content = message.content;
    return typeof content === 'string' && content.length > 0 ? [content] : [];
  }
  if (message.type === 'attachment') {
    const command = parseClaudeQueuedCommandAttachment(message);
    return command ? [command.prompt] : [];
  }
  return [];
}

function readPromptTexts(message: unknown): readonly string[] {
  const record = readObject(message);
  if (!record) return [];
  if (record.type === 'user') return readUserPromptTexts(record as RawJSONLines);
  return readQueuedCommandPromptTexts(record);
}

function promptTextsMatch(transcriptText: string, acceptedPrompt: AcceptedPrompt): boolean {
  const normalizedTranscriptText = normalizeClaudeUnifiedPromptIdentityText(transcriptText);
  if (normalizedTranscriptText === acceptedPrompt.normalizedText) return true;
  return normalizedTranscriptText.startsWith('/')
    && acceptedPrompt.normalizedText.startsWith(`${normalizedTranscriptText} `);
}

function isCommandNameOnlyFallbackMatch(transcriptText: string, acceptedPrompt: AcceptedPrompt): boolean {
  const normalizedTranscriptText = normalizeClaudeUnifiedPromptIdentityText(transcriptText);
  return normalizedTranscriptText.startsWith('/')
    && normalizedTranscriptText !== acceptedPrompt.normalizedText
    && acceptedPrompt.normalizedText.startsWith(`${normalizedTranscriptText} `);
}

function cloneDeliveryIdentity(
  value: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null | undefined,
): ClaudeUnifiedAcceptedPromptDeliveryIdentity | null {
  if (!value) return null;
  return {
    ...(value.localIds ? { localIds: [...value.localIds] } : {}),
    ...(typeof value.userMessageSeq === 'number' || value.userMessageSeq === null
      ? { userMessageSeq: value.userMessageSeq }
      : {}),
    ...(value.userMessageSeqs ? { userMessageSeqs: [...value.userMessageSeqs] } : {}),
  };
}

function buildTranscriptKey(params: Readonly<{
  record: Record<string, unknown> | null;
  message: unknown;
  texts: readonly string[];
}>): string | null {
  const uuid = readNonEmptyString(params.record?.uuid);
  if (uuid) return `uuid:${uuid}`;
  const promptId = readNonEmptyString(params.record?.promptId);
  if (promptId) return `prompt:${promptId}`;
  const timestampMs = readMessageTimestampMs(params.message);
  if (timestampMs === null) return null;
  const normalizedTexts = params.texts
    .map((text) => normalizeClaudeUnifiedPromptIdentityText(text))
    .filter((text) => text.length > 0);
  return normalizedTexts.length > 0
    ? `ts:${timestampMs}:text:${normalizedTexts.join('\u0000')}`
    : `ts:${timestampMs}`;
}

function readValidSeqs(value: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null | undefined): Set<number> {
  const seqs = new Set<number>();
  const userMessageSeq = value?.userMessageSeq;
  if (typeof userMessageSeq === 'number' && Number.isInteger(userMessageSeq) && userMessageSeq >= 0) {
    seqs.add(userMessageSeq);
  }
  for (const seq of value?.userMessageSeqs ?? []) {
    if (Number.isInteger(seq) && seq >= 0) {
      seqs.add(seq);
    }
  }
  return seqs;
}

function readValidLocalIds(value: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null | undefined): Set<string> {
  const localIds = new Set<string>();
  for (const localId of value?.localIds ?? []) {
    const normalized = typeof localId === 'string' ? localId.trim() : '';
    if (normalized.length > 0) {
      localIds.add(normalized);
    }
  }
  return localIds;
}

function doesBatchMatchDeliveryIdentity(
  acceptedPrompt: AcceptedPrompt,
  batch: Readonly<{
    maxUserMessageSeq?: number | null | undefined;
    userMessageLocalIds?: readonly string[] | null | undefined;
  }>,
): boolean {
  const seqs = readValidSeqs(acceptedPrompt.deliveryIdentity);
  const localIds = readValidLocalIds(acceptedPrompt.deliveryIdentity);
  const hasDeliveryIdentity = seqs.size > 0 || localIds.size > 0;
  if (!hasDeliveryIdentity) return false;

  const batchSeq = batch.maxUserMessageSeq;
  if (typeof batchSeq === 'number' && seqs.has(batchSeq)) return true;
  return (batch.userMessageLocalIds ?? []).some((localId) => (
    localIds.has(typeof localId === 'string' ? localId.trim() : '')
  ));
}

export function createClaudeUnifiedAcceptedPromptTranscriptDiscovery(opts: Readonly<{
  acceptedPromptWindowMs: number;
  nowMs?: (() => number) | undefined;
}>): ClaudeUnifiedAcceptedPromptTranscriptDiscovery {
  const acceptedPrompts: AcceptedPrompt[] = [];
  const nowMs = opts.nowMs ?? Date.now;
  const acceptedPromptWindowMs = Math.max(100, Math.trunc(opts.acceptedPromptWindowMs));
  const consumedTranscriptKeys = new Set<string>();
  let nextAcceptedPromptId = 1;

  function pruneExpired(referenceMs: number): void {
    while (acceptedPrompts.length > 0) {
      const next = acceptedPrompts[0];
      if (!next || next.expiresAtMs >= referenceMs) return;
      acceptedPrompts.shift();
    }
  }

  function matchesPromptWindow(message: unknown, acceptedPrompt: AcceptedPrompt): boolean {
    const timestampMs = readMessageTimestampMs(message);
    if (timestampMs === null) {
      return nowMs() <= acceptedPrompt.expiresAtMs;
    }
    return timestampMs >= acceptedPrompt.acceptedAtMs - acceptedPromptWindowMs
      && timestampMs <= acceptedPrompt.expiresAtMs;
  }

  function findMatchingTranscript(messages: readonly unknown[]): ClaudeUnifiedAcceptedPromptTranscriptMatch | null {
    pruneExpired(nowMs());
    for (const message of messages) {
      const record = readObject(message);
      const texts = readPromptTexts(message);
      if (texts.length === 0) continue;
      const transcriptKey = buildTranscriptKey({ record, message, texts });
      if (transcriptKey && consumedTranscriptKeys.has(transcriptKey)) continue;
      let matchIndex = -1;
      let matchKind: ClaudeUnifiedAcceptedPromptTranscriptMatch['matchKind'] = 'exact';
      for (const text of texts) {
        const matchingIndices = acceptedPrompts
          .map((acceptedPrompt, index) => ({ acceptedPrompt, index }))
          .filter(({ acceptedPrompt }) => (
            promptTextsMatch(text, acceptedPrompt) && matchesPromptWindow(message, acceptedPrompt)
          ));
        if (matchingIndices.length === 0) continue;
        const normalizedText = normalizeClaudeUnifiedPromptIdentityText(text);
        const exactMatch = matchingIndices.find(({ acceptedPrompt }) => acceptedPrompt.normalizedText === normalizedText);
        if (exactMatch) {
          matchIndex = exactMatch.index;
          matchKind = 'exact';
          break;
        }
        const fallbackMatches = matchingIndices.filter(({ acceptedPrompt }) => (
          isCommandNameOnlyFallbackMatch(text, acceptedPrompt)
        ));
        if (fallbackMatches.length > 1 && fallbackMatches.length === matchingIndices.length) {
          continue;
        }
        matchIndex = matchingIndices[0]?.index ?? -1;
        matchKind = 'command_name';
        break;
      }
      if (matchIndex < 0) continue;
      const acceptedPrompt = acceptedPrompts[matchIndex];
      if (!acceptedPrompt) continue;
      return {
        acceptedPromptId: acceptedPrompt.id,
        acceptedPromptNormalizedText: acceptedPrompt.normalizedText,
        deliveryIdentity: cloneDeliveryIdentity(acceptedPrompt.deliveryIdentity),
        transcriptUuid: readNonEmptyString(record?.uuid),
        transcriptPromptId: readNonEmptyString(record?.promptId),
        transcriptTimestampMs: readMessageTimestampMs(message),
        matchKind,
        transcriptKey,
      };
    }
    return null;
  }

  function consumeAcceptedPromptMatch(match: ClaudeUnifiedAcceptedPromptTranscriptMatch): boolean {
    const matchIndex = acceptedPrompts.findIndex((acceptedPrompt) => acceptedPrompt.id === match.acceptedPromptId);
    if (matchIndex < 0) return false;
    acceptedPrompts.splice(matchIndex, 1);
    if (match.transcriptKey) {
      consumedTranscriptKeys.add(match.transcriptKey);
    }
    return true;
  }

  function claimMatchingTranscript(messages: readonly unknown[]): ClaudeUnifiedAcceptedPromptTranscriptMatch | null {
    const match = findMatchingTranscript(messages);
    if (!match) return null;
    return consumeAcceptedPromptMatch(match) ? match : null;
  }

  return {
    recordAcceptedPrompt(input) {
      const normalizedText = normalizeClaudeUnifiedPromptIdentityText(input.message);
      if (normalizedText.length === 0) return;
      const rawAcceptedAtMs = input.acceptedAtMs;
      const acceptedAtMs =
        typeof rawAcceptedAtMs === 'number' && Number.isFinite(rawAcceptedAtMs)
          ? Math.trunc(rawAcceptedAtMs)
          : nowMs();
      pruneExpired(acceptedAtMs);
      acceptedPrompts.push({
        id: `accepted-prompt-${nextAcceptedPromptId++}`,
        text: input.message,
        normalizedText,
        deliveryIdentity: cloneDeliveryIdentity(input.deliveryIdentity),
        acceptedAtMs,
        expiresAtMs: acceptedAtMs + acceptedPromptWindowMs,
      });
    },

    consumeAcceptedPromptByBatch(input) {
      const normalizedText = normalizeClaudeUnifiedPromptIdentityText(input.message);
      if (normalizedText.length === 0) return false;
      pruneExpired(nowMs());
      const matchIndex = acceptedPrompts.findIndex((acceptedPrompt) => (
        acceptedPrompt.normalizedText === normalizedText
        && doesBatchMatchDeliveryIdentity(acceptedPrompt, input)
      ));
      if (matchIndex < 0) return false;
      acceptedPrompts.splice(matchIndex, 1);
      return true;
    },

    findMatchingTranscript,

    consumeAcceptedPromptMatch,

    claimMatchingTranscript,

    consumeMatchingTranscript(messages) {
      return claimMatchingTranscript(messages) !== null;
    },
  };
}
