import axios from 'axios';

import { resolveLatestPermissionIntent } from '@happier-dev/agents';

import { logger } from '@/ui/logger';
import { isAuthenticationError } from '../client/httpStatusError';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

import { decodeBase64, decrypt } from '../encryption';
import { SessionMessageContentSchema, type PermissionMode } from '../types';
import { extractSemanticTranscriptItem } from '@/session/services/transcript/extractSemanticTranscriptItem';
import type { SemanticTranscriptItem, SemanticTranscriptRole } from '@/session/services/transcript/semanticTranscriptItem';

type EncryptionVariant = 'legacy' | 'dataKey';

type SessionTranscriptQueryParams = {
  token: string;
  sessionId: string;
  encryptionKey: Uint8Array;
  encryptionVariant: EncryptionVariant;
};

function normalizeTake(value: number | undefined, max: number): number {
  if (typeof value !== 'number' || value <= 0) return max;
  return Math.min(value, max);
}

function logTranscriptQueryFailure(message: string, error: unknown): void {
  logger.debug(message, { error: serializeAxiosErrorForLog(error) });
}

export async function fetchRecentTranscriptTextItemsForAcpImportFromServer(
  params: SessionTranscriptQueryParams & { take?: number },
): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
  const take = normalizeTake(params.take, 150);
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, roles: 'user,agent' },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return [];

    const items: Array<{ role: 'user' | 'agent'; text: string; createdAt: number }> = [];

    for (let index = 0; index < raw.length && items.length < take; index += 1) {
      const msg = raw[index];
      const extracted = extractSemanticTranscriptItem({
        row: msg,
        index,
        ctx: {
          encryptionKey: params.encryptionKey,
          encryptionVariant: params.encryptionVariant,
        },
        options: {
          mode: 'transcript',
          transcriptRoles: ['user', 'assistant'],
          maxTextChars: null,
        },
      }).item;
      if (!extracted?.text || (extracted.role !== 'user' && extracted.role !== 'assistant')) continue;
      items.push({
        role: extracted.role === 'user' ? 'user' : 'agent',
        text: extracted.text,
        createdAt: extracted.createdAt,
      });
    }

    // API returns newest first; normalize to chronological.
    items.sort((a, b) => a.createdAt - b.createdAt);
    return items.map((item) => ({ role: item.role, text: item.text }));
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for ACP import', error);
    return [];
  }
}

export async function fetchLatestUserPermissionIntentFromEncryptedTranscript(
  params: SessionTranscriptQueryParams & { take?: number },
): Promise<{ intent: PermissionMode; updatedAt: number } | null> {
  const take = normalizeTake(params.take, 200);
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, role: 'user' },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return null;

    const sliced = raw.slice(0, take);
    const candidates: Array<{ rawMode: unknown; updatedAt: unknown }> = [];

    for (const msg of sliced) {
      const createdAt = typeof msg?.createdAt === 'number' ? msg.createdAt : null;
      if (createdAt === null) continue;
      const content = msg?.content;
      const parsedContent = SessionMessageContentSchema.safeParse(content);
      if (!parsedContent.success) continue;

      let decrypted: unknown;
      if (parsedContent.data.t === 'plain') {
        decrypted = parsedContent.data.v;
      } else {
        decrypted = decrypt(
          params.encryptionKey,
          params.encryptionVariant,
          decodeBase64(parsedContent.data.c),
        );
      }
      const decryptedObj = decrypted && typeof decrypted === 'object' ? (decrypted as Record<string, unknown>) : null;
      if (decryptedObj?.role !== 'user') continue;
      const body = decryptedObj.content;
      const bodyObj = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
      if (bodyObj?.type !== 'text' || typeof bodyObj.text !== 'string' || bodyObj.text.trim().length === 0) continue;

      const meta = decryptedObj?.meta;
      const rawMode = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).permissionMode : null;
      if (typeof rawMode !== 'string' || rawMode.trim().length === 0) continue;

      candidates.push({ rawMode, updatedAt: createdAt });
    }

    const resolved = resolveLatestPermissionIntent(candidates);
    if (!resolved) return null;
    return { intent: resolved.intent as PermissionMode, updatedAt: resolved.updatedAt };
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for permission intent resolution', error);
    return null;
  }
}

export async function hasCommittedUserMessageAfterMs(params: Readonly<{
  token: string;
  sessionId: string;
  failureAtMs: number;
  take?: number;
}>): Promise<boolean> {
  const take = normalizeTake(params.take, 25);
  const failureAtMs = Number.isFinite(params.failureAtMs)
    ? Math.max(0, Math.trunc(params.failureAtMs))
    : 0;
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, role: 'user' },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return false;

    return raw.some((msg) => {
      const createdAt = typeof msg?.createdAt === 'number' && Number.isFinite(msg.createdAt)
        ? Math.trunc(msg.createdAt)
        : null;
      return createdAt !== null && createdAt > failureAtMs;
    });
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for continuation recovery suppression', error);
    return false;
  }
}

export type CommittedProviderActivityAfterUserPromptEvidence =
  | Readonly<{
      status: 'activity_found';
      latestUserMessageAtMs: number;
      activityAtMs: number;
      activityKind: string;
      activityRole: Exclude<SemanticTranscriptRole, 'user'>;
    }>
  | Readonly<{
      status: 'no_activity_found';
      latestUserMessageAtMs: number;
    }>
  | Readonly<{
      status: 'unknown';
      reason:
        | 'latest_user_prompt_unavailable'
        | 'transcript_unavailable'
        | 'ambiguous_post_prompt_row';
    }>;

function readTranscriptCreatedAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

export async function detectCommittedProviderActivityAfterLatestUserPrompt(
  params: SessionTranscriptQueryParams & Readonly<{
    failureAtMs: number;
    take?: number;
  }>,
): Promise<CommittedProviderActivityAfterUserPromptEvidence> {
  const take = normalizeTake(params.take, 100);
  const failureAtMs = Number.isFinite(params.failureAtMs)
    ? Math.max(0, Math.trunc(params.failureAtMs))
    : 0;
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return { status: 'unknown', reason: 'transcript_unavailable' };

    const transcriptRows = raw
      .map((msg, index) => {
        const record = msg && typeof msg === 'object' && !Array.isArray(msg)
          ? msg as Record<string, unknown>
          : null;
        if (!record) return null;
        const createdAt = readTranscriptCreatedAt(record.createdAt);
        if (createdAt === null) return null;
        const item = extractSemanticTranscriptItem({
          row: record,
          index,
          ctx: {
            encryptionKey: params.encryptionKey,
            encryptionVariant: params.encryptionVariant,
          },
          options: {
            mode: 'transcript',
            transcriptRoles: ['user', 'assistant'],
            includeTools: true,
            includeReasoning: true,
            includeEvents: true,
            maxTextChars: null,
          },
        }).item;
        return { createdAt, item };
      })
      .filter((row): row is { createdAt: number; item: SemanticTranscriptItem | null } => row !== null);

    const latestUser = transcriptRows
      .filter((row): row is { createdAt: number; item: SemanticTranscriptItem } =>
        row.item?.semanticRole === 'user' && row.createdAt <= failureAtMs)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    if (!latestUser) {
      return { status: 'unknown', reason: 'latest_user_prompt_unavailable' };
    }

    const laterRows = transcriptRows
      .filter((row) => row.createdAt > latestUser.createdAt)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (laterRows.some((row) => row.item === null)) {
      return { status: 'unknown', reason: 'ambiguous_post_prompt_row' };
    }
    const semanticLaterRows = laterRows as Array<{ createdAt: number; item: SemanticTranscriptItem }>;
    const providerActivity = semanticLaterRows.find((row) => row.item.semanticRole !== 'user') ?? null;
    if (providerActivity) {
      return {
        status: 'activity_found',
        latestUserMessageAtMs: latestUser.createdAt,
        activityAtMs: providerActivity.createdAt,
        activityKind: providerActivity.item.kind,
        activityRole: providerActivity.item.semanticRole as Exclude<SemanticTranscriptRole, 'user'>,
      };
    }

    return {
      status: 'no_activity_found',
      latestUserMessageAtMs: latestUser.createdAt,
    };
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for connected-service provider activity evidence', error);
    return { status: 'unknown', reason: 'transcript_unavailable' };
  }
}

export type LatestCommittedUserTextBeforeFailure = Readonly<{
  text: string;
  localId: string | null;
  createdAt: number;
  permissionMode: string | null;
  model: string | null;
}>;

function readUserTextRecordFromTranscriptContent(input: Readonly<{
  content: unknown;
  encryptionKey: Uint8Array;
  encryptionVariant: EncryptionVariant;
}>): Readonly<{
  text: string;
  permissionMode: string | null;
  model: string | null;
}> | null {
  const parsedContent = SessionMessageContentSchema.safeParse(input.content);
  if (!parsedContent.success) return null;

  let decoded: unknown;
  if (parsedContent.data.t === 'plain') {
    decoded = parsedContent.data.v;
  } else {
    try {
      decoded = decrypt(
        input.encryptionKey,
        input.encryptionVariant,
        decodeBase64(parsedContent.data.c),
      );
    } catch {
      return null;
    }
  }

  const decodedObj = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : null;
  if (decodedObj?.role !== 'user') return null;
  const body = decodedObj.content;
  const bodyObj = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  if (bodyObj?.type !== 'text' || typeof bodyObj.text !== 'string') return null;
  const text = bodyObj.text.trim();
  if (!text) return null;
  const meta = decodedObj.meta && typeof decodedObj.meta === 'object' && !Array.isArray(decodedObj.meta)
    ? decodedObj.meta as Record<string, unknown>
    : null;
  const permissionMode = typeof meta?.permissionMode === 'string' && meta.permissionMode.trim().length > 0
    ? meta.permissionMode.trim()
    : null;
  const model = typeof meta?.model === 'string' && meta.model.trim().length > 0
    ? meta.model.trim()
    : null;
  return { text, permissionMode, model };
}

export async function fetchLatestCommittedUserTextAtOrBeforeMs(
  params: SessionTranscriptQueryParams & Readonly<{
    failureAtMs: number;
    take?: number;
  }>,
): Promise<LatestCommittedUserTextBeforeFailure | null> {
  const take = normalizeTake(params.take, 25);
  const failureAtMs = Number.isFinite(params.failureAtMs)
    ? Math.max(0, Math.trunc(params.failureAtMs))
    : 0;
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, role: 'user' },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return null;

    const candidates = raw
      .map((msg): LatestCommittedUserTextBeforeFailure | null => {
        const record = msg && typeof msg === 'object' && !Array.isArray(msg)
          ? msg as Record<string, unknown>
          : null;
        if (!record) return null;
        const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
          ? Math.trunc(record.createdAt)
          : null;
        if (createdAt === null || createdAt > failureAtMs) return null;
        const decoded = readUserTextRecordFromTranscriptContent({
          content: record.content,
          encryptionKey: params.encryptionKey,
          encryptionVariant: params.encryptionVariant,
        });
        if (!decoded) return null;
        return {
          text: decoded.text,
          localId: typeof record.localId === 'string' && record.localId.trim().length > 0
            ? record.localId.trim()
            : null,
          createdAt,
          permissionMode: decoded.permissionMode,
          model: decoded.model,
        };
      })
      .filter((candidate): candidate is LatestCommittedUserTextBeforeFailure => candidate !== null)
      .sort((a, b) => b.createdAt - a.createdAt);

    return candidates[0] ?? null;
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for original-message retry', error);
    return null;
  }
}
