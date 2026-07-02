import { normalizeVoiceAgentTurnTranscriptText, type HappierReplayDialogItem } from '@happier-dev/agents';
import { SessionSynopsisV1Schema, VoiceAgentTurnV1Schema } from '@happier-dev/protocol';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { Credentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';
import { fetchEncryptedTranscriptMessages } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { extractSemanticTranscriptItemFromDecryptedPayload } from '@/session/services/transcript/extractSemanticTranscriptItem';
import { fetchLatestMemorySynopsisSystemRecord } from '@/session/systemRecords/memory/fetchMemorySystemRecords';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

function truncateReplayText(text: string, maxTextChars?: number): string {
  const normalizedMax =
    typeof maxTextChars === 'number' && Number.isFinite(maxTextChars) && maxTextChars > 0
      ? Math.max(1, Math.min(50_000, Math.floor(maxTextChars)))
      : 50_000;
  if (text.length <= normalizedMax) return text;
  const suffix = '...[truncated]';
  if (normalizedMax <= suffix.length) {
    return text.slice(0, normalizedMax);
  }
  return text.slice(0, normalizedMax - suffix.length) + suffix;
}

async function tryHydrateSynopsisFromSystemRecord(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
}>): Promise<string | null> {
  const synopsis = await fetchLatestMemorySynopsisSystemRecord({
    token: params.credentials.token,
    sessionId: params.sessionId,
    mode: params.mode,
    ...(params.mode === 'e2ee' ? { ctx: params.ctx } : {}),
  }).catch(() => {
    return null;
  });
  const text = typeof synopsis?.synopsis === 'string' ? synopsis.synopsis.trim() : '';
  return text.length > 0 ? text : null;
}

export async function hydrateVoiceReplayDialogFromTranscript(params: Readonly<{
  credentials: Credentials;
  previousSessionId: string;
  transcriptEpoch: number;
  limit: number;
  maxTextChars?: number;
}>): Promise<{ dialog: HappierReplayDialogItem[]; sourceCutoffSeqInclusive: number; synopsisText?: string | null } | null> {
  const session = await fetchSessionById({ token: params.credentials.token, sessionId: params.previousSessionId }).catch((error) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  if (!session) return null;

  const sessionSeq =
    typeof (session as any)?.seq === 'number' && Number.isFinite((session as any).seq) ? Math.max(0, Math.floor((session as any).seq)) : 0;

  const rows = await fetchEncryptedTranscriptMessages({
    token: params.credentials.token,
    sessionId: params.previousSessionId,
    limit: params.limit,
  }).catch((error) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  if (!rows) return null;

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, session as any);
  const encryptionMode = resolveSessionStoredContentEncryptionMode(session as any);
  const systemRecordSynopsis = await tryHydrateSynopsisFromSystemRecord({
    credentials: params.credentials,
    sessionId: params.previousSessionId,
    mode: encryptionMode,
    ctx,
  });
  const decryptedRows = decryptTranscriptRows({ ctx, rows });
  if (decryptedRows.length === 0) {
    return { dialog: [], sourceCutoffSeqInclusive: sessionSeq, synopsisText: null };
  }

  const transcriptEpoch = Number.isFinite(params.transcriptEpoch) && params.transcriptEpoch >= 0
    ? Math.floor(params.transcriptEpoch)
    : 0;

  let bestSynopsis: { synopsis: string; updatedAtMs: number; seqTo: number } | null = null;
  const dialog: HappierReplayDialogItem[] = [];

  for (let index = 0; index < decryptedRows.length; index += 1) {
    const row = decryptedRows[index]!;
    const happier = row.meta && typeof row.meta === 'object' ? (row.meta as any).happier : null;
    if (happier?.kind === 'session_synopsis.v1') {
      const parsedSynopsis = SessionSynopsisV1Schema.safeParse(happier.payload);
      if (parsedSynopsis.success) {
        const candidate = parsedSynopsis.data;
        if (
          !bestSynopsis
          || candidate.updatedAtMs > bestSynopsis.updatedAtMs
          || (candidate.updatedAtMs === bestSynopsis.updatedAtMs && candidate.seqTo > bestSynopsis.seqTo)
        ) {
          bestSynopsis = candidate;
        }
      }
    }

    if (happier?.kind !== 'voice_agent_turn.v1') continue;
    const parsedTurn = VoiceAgentTurnV1Schema.safeParse(happier.payload);
    if (!parsedTurn.success || parsedTurn.data.epoch !== transcriptEpoch) continue;

    const extracted = extractSemanticTranscriptItemFromDecryptedPayload({
      decrypted: {
        role: row.role,
        content: row.content,
        ...(row.meta !== undefined ? { meta: row.meta } : {}),
      },
      row: {
        seq: row.seq,
        createdAt: row.createdAtMs,
      },
      index,
      options: {
        mode: 'transcript',
        transcriptRoles: ['user', 'assistant'],
        includeTools: false,
        includeReasoning: false,
        includeEvents: false,
        maxTextChars: null,
      },
    });
    const text = normalizeVoiceAgentTurnTranscriptText(extracted.item?.text);
    if (!text) continue;

    dialog.push({
      role: parsedTurn.data.role === 'assistant' ? 'Assistant' : 'User',
      createdAt: row.createdAtMs,
      text: truncateReplayText(text, params.maxTextChars),
    });
  }

  dialog.sort((left, right) => left.createdAt - right.createdAt);

  return {
    dialog,
    sourceCutoffSeqInclusive: sessionSeq,
    synopsisText: systemRecordSynopsis
      ?? (typeof bestSynopsis?.synopsis === 'string' && bestSynopsis.synopsis.trim().length > 0
        ? bestSynopsis.synopsis.trim()
        : null),
  };
}
