import { stat } from 'node:fs/promises';

import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';
import {
  hashCodexLegacyUserMessagePrompt,
  type CodexLegacyUserMessageIdentityRecord,
} from './codexLegacyUserMessageIdentityLedger';

type UserMessageEvidence = Readonly<{
  userResponseOffsets: ReadonlySet<number>;
  responseOffsetsWithMatchingEvent: ReadonlySet<number>;
  responseOffsetsWithAuthoritativeBoundary: ReadonlySet<number>;
  localIdByOffset: ReadonlyMap<number, string>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readEventText(value: unknown): string | null {
  const envelope = asRecord(value);
  const payload = asRecord(envelope?.payload);
  return envelope?.type === 'event_msg'
    && payload?.type === 'user_message'
    && typeof payload.message === 'string'
    && payload.message.length > 0
    ? payload.message
    : null;
}

function readResponseTextCandidates(value: unknown): readonly string[] {
  const envelope = asRecord(value);
  const payload = asRecord(envelope?.payload);
  if (envelope?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') return [];
  if (!Array.isArray(payload.content)) return [];
  const textParts = payload.content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== null)
    .filter((part) => part.type === 'text' || part.type === 'input_text')
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter((text) => text.length > 0);
  return [...new Set([...textParts, textParts.join('')].filter((text) => text.length > 0))];
}

function isAuthoritativeUserResponseBoundary(value: unknown): boolean {
  const envelope = asRecord(value);
  if (envelope?.type === 'turn_context') return true;
  if (envelope?.type !== 'event_msg') return false;
  const payload = asRecord(envelope.payload);
  return payload?.type === 'task_complete'
    || payload?.type === 'turn_complete'
    || payload?.type === 'turn_aborted';
}

/**
 * Index real rollout evidence before projecting a page. A response_item is suppressed only
 * when this same file contains an adjacent user_message event with canonical text evidence.
 * A single text part also counts so attachment annotations do not create a second transcript row.
 * FIFO matching preserves duplicate sends as distinct observations across page boundaries.
 */
export async function collectCodexDirectUserMessageEvidence(params: Readonly<{
  filePath: string;
  fileRelPath: string;
  legacyIdentityRecords?: readonly CodexLegacyUserMessageIdentityRecord[];
}>): Promise<UserMessageEvidence> {
  const filePath = params.filePath;
  const fileSize = await stat(filePath).then((value) => Math.max(0, Math.trunc(value.size))).catch(() => 0);
  const events: Array<{ offset: number; text: string }> = [];
  const responses: Array<{ offset: number; textCandidates: readonly string[] }> = [];
  const authoritativeBoundaryOffsets: number[] = [];
  let offsetBytes = 0;

  while (offsetBytes < fileSize) {
    const page = await readJsonlFileForward({
      filePath,
      offsetBytes,
      maxBytes: 1024 * 1024,
      maxItems: 1024,
    });
    for (const line of page.items) {
      // Ignore a parseable but not-yet-newline-committed tail.
      if (line.endOffsetBytes >= fileSize) continue;
      const eventText = readEventText(line.value);
      if (eventText !== null) {
        events.push({ offset: line.startOffsetBytes, text: eventText });
      }
      const responseTextCandidates = readResponseTextCandidates(line.value);
      if (responseTextCandidates.length > 0) {
        responses.push({ offset: line.startOffsetBytes, textCandidates: responseTextCandidates });
      }
      if (isAuthoritativeUserResponseBoundary(line.value)) {
        authoritativeBoundaryOffsets.push(line.startOffsetBytes);
      }
    }
    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    offsetBytes = page.nextOffsetBytes;
  }

  const responseOffsetsWithMatchingEvent = new Set<number>();
  const responseOffsetsWithAuthoritativeBoundary = new Set<number>();
  const userResponseOffsets = new Set(responses.map((response) => response.offset));
  const canonicalObservationsByPromptHash = new Map<string, number[]>();
  const matchedResponseIndexes = new Set<number>();
  const matchedEventIndexes = new Set<number>();
  const observationPositions = new Map<string, number>();
  [
    ...events.map((event, index) => ({ key: `event:${index}`, offset: event.offset })),
    ...responses.map((response, index) => ({ key: `response:${index}`, offset: response.offset })),
  ]
    .sort((left, right) => left.offset - right.offset)
    .forEach((observation, position) => observationPositions.set(observation.key, position));
  const addCanonicalObservation = (texts: readonly string[], offset: number) => {
    for (const text of texts) {
      const promptHash = hashCodexLegacyUserMessagePrompt(text);
      const offsets = canonicalObservationsByPromptHash.get(promptHash) ?? [];
      if (!offsets.includes(offset)) offsets.push(offset);
      canonicalObservationsByPromptHash.set(promptHash, offsets);
    }
  };
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    const eventPosition = observationPositions.get(`event:${eventIndex}`)!;
    const responseIndex = responses.findIndex((response, index) =>
      !matchedResponseIndexes.has(index)
      && response.textCandidates.includes(event.text)
      && Math.abs(observationPositions.get(`response:${index}`)! - eventPosition) === 1);
    if (responseIndex < 0) continue;
    const response = responses[responseIndex]!;
    matchedResponseIndexes.add(responseIndex);
    matchedEventIndexes.add(eventIndex);
    responseOffsetsWithMatchingEvent.add(response.offset);
    addCanonicalObservation([...response.textCandidates, event.text], event.offset);
  }
  responses.forEach((response, index) => {
    if (!matchedResponseIndexes.has(index)) addCanonicalObservation(response.textCandidates, response.offset);
  });
  events.forEach((event, index) => {
    if (!matchedEventIndexes.has(index)) addCanonicalObservation([event.text], event.offset);
  });
  const userObservationOffsets = [
    ...events.map((event) => event.offset),
    ...responses.map((response) => response.offset),
  ].sort((left, right) => left - right);
  responses.forEach((response, index) => {
    if (matchedResponseIndexes.has(index)) return;
    const nextUserObservationOffset = userObservationOffsets.find((offset) => offset > response.offset) ?? Number.POSITIVE_INFINITY;
    if (authoritativeBoundaryOffsets.some((offset) => offset > response.offset && offset < nextUserObservationOffset)) {
      responseOffsetsWithAuthoritativeBoundary.add(response.offset);
    }
  });
  for (const offsets of canonicalObservationsByPromptHash.values()) offsets.sort((left, right) => left - right);

  const localIdByOffset = new Map<number, string>();
  const usedOffsets = new Set<number>();
  for (const record of params.legacyIdentityRecords ?? []) {
    if (record.fileRelPath !== params.fileRelPath) continue;
    const offset = (canonicalObservationsByPromptHash.get(record.promptSha256) ?? [])
      .find((candidate) => candidate >= record.offsetBytes && !usedOffsets.has(candidate));
    if (offset === undefined) continue;
    usedOffsets.add(offset);
    localIdByOffset.set(offset, record.pendingLocalId);
  }
  return {
    userResponseOffsets,
    responseOffsetsWithMatchingEvent,
    responseOffsetsWithAuthoritativeBoundary,
    localIdByOffset,
  };
}
