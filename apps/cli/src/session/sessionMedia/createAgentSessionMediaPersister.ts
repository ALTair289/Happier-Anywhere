import type { AgentMessage, SessionMediaSource, SessionMediaSourceOrigin } from '@/agent/core';
import { createHash } from 'node:crypto';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import {
  createTransferPathAllowanceRegistry,
  type TransferPathAllowanceRegistry,
} from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { SessionMediaItemV1Schema, type SessionMediaItemV1 } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';

import {
  persistSessionMediaItem,
  type PersistSessionMediaInput,
} from './persistSessionMediaItem';
import type {
  SessionMediaIngestionSource,
  SessionMediaOrigin,
} from './sessionMediaIngestionSource';

type RuntimeSessionMediaMessage = Extract<AgentMessage, { type: 'session-media' }>;

type AgentSessionMediaPersisterParams = Readonly<{
  workingDirectory: string;
  sessionId: string;
  accessPolicy?: FilesystemAccessPolicy;
  pathAllowanceRegistry?: TransferPathAllowanceRegistry;
  maxBytes?: number;
  sessionRpcTransferMaxBytes?: number | null;
  onUnavailable?: (diagnostic: SessionMediaUnavailableDiagnostic) => void;
}>;

export type SessionMediaUnavailableDiagnostic = Readonly<{
  code: string;
  source: string;
  agentId?: string;
  toolCallIdHash?: string;
  generationIdHash?: string;
}>;

function boundedCorrelationHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mapMediaCategory(origin: SessionMediaSourceOrigin): PersistSessionMediaInput['category'] {
  return origin.source === 'tool-output' ? 'tool-artifact' : 'generated';
}

function mapOrigin(origin: SessionMediaSourceOrigin): SessionMediaOrigin {
  return {
    source: origin.source,
    ...(typeof origin.agentId === 'string' ? { agentId: origin.agentId } : {}),
    ...(typeof origin.toolCallId === 'string' ? { toolCallId: origin.toolCallId } : {}),
    ...(typeof origin.generationId === 'string' ? { generationId: origin.generationId } : {}),
    ...(typeof origin.providerEventId === 'string' ? { providerEventId: origin.providerEventId } : {}),
    ...(typeof origin.providerFileId === 'string' ? { providerFileId: origin.providerFileId } : {}),
  };
}

function mapSource(source: SessionMediaSource): SessionMediaIngestionSource {
  if (source.kind === 'base64') {
    return {
      kind: 'base64',
      data: source.data,
      mimeType: source.mimeType,
      ...(source.suggestedName ? { suggestedName: source.suggestedName } : {}),
    };
  }
  if (source.kind === 'local-file') {
    return {
      kind: 'local-file',
      path: source.path,
      ...(source.mimeType ? { mimeType: source.mimeType } : {}),
      ...(source.suggestedName ? { suggestedName: source.suggestedName } : {}),
    };
  }
  return {
    kind: 'local-uri',
    uri: source.uri,
    ...(source.mimeType ? { mimeType: source.mimeType } : {}),
    ...(source.suggestedName ? { suggestedName: source.suggestedName } : {}),
  };
}

function buildMessageLocalId(message: RuntimeSessionMediaMessage, index: number): string {
  const source = message.media[index]?.origin;
  const stableId =
    source?.providerEventId ??
    source?.generationId ??
    source?.toolCallId ??
    source?.providerFileId ??
    message.source;
  const boundedStableId = createHash('sha256')
    .update(message.source)
    .update('\0')
    .update(stableId)
    .digest('hex');
  return `session-media-${boundedStableId}-${index}`;
}

export function createAgentSessionMediaPersister(
  params: AgentSessionMediaPersisterParams,
): { persist: (message: RuntimeSessionMediaMessage) => Promise<SessionMediaItemV1[]> } {
  const pathAllowanceRegistry = params.pathAllowanceRegistry ?? createTransferPathAllowanceRegistry();

  const reportUnavailable = (
    message: RuntimeSessionMediaMessage,
    media: SessionMediaSource,
    code: string,
  ): void => {
    const diagnostic: SessionMediaUnavailableDiagnostic = {
      code: code.slice(0, 128),
      source: message.source.slice(0, 128),
      ...(typeof media.origin.agentId === 'string'
        ? { agentId: media.origin.agentId.slice(0, 512) }
        : {}),
      ...(typeof media.origin.toolCallId === 'string'
        ? { toolCallIdHash: boundedCorrelationHash(media.origin.toolCallId) }
        : {}),
      ...(typeof media.origin.generationId === 'string'
        ? { generationIdHash: boundedCorrelationHash(media.origin.generationId) }
        : {}),
    };
    logger.debug('[session-media] Media unavailable after bounded persistence validation', diagnostic);
    try {
      params.onUnavailable?.(diagnostic);
    } catch {
      logger.debug('[session-media] Media unavailable observer failed (non-fatal)');
    }
  };

  return {
    async persist(message) {
      const items: SessionMediaItemV1[] = [];
      for (let index = 0; index < message.media.length; index += 1) {
        const media = message.media[index]!;
        let result: Awaited<ReturnType<typeof persistSessionMediaItem>>;
        try {
          result = await persistSessionMediaItem({
            workingDirectory: params.workingDirectory,
            pathAllowanceRegistry,
            sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
            ...(params.accessPolicy ? { accessPolicy: params.accessPolicy } : {}),
            ...(typeof params.maxBytes === 'number' ? { maxBytes: params.maxBytes } : {}),
            input: {
              sessionId: params.sessionId,
              messageLocalId: buildMessageLocalId(message, index),
              role: 'output',
              category: mapMediaCategory(media.origin),
              source: mapSource(media),
              origin: mapOrigin(media.origin),
              ...(media.kind === 'local-file' && media.description
                ? { description: media.description }
                : {}),
              ...(media.kind === 'local-file' && media.referenceImagePaths?.length
                ? { referenceImagePaths: media.referenceImagePaths }
                : {}),
              ...(media.suggestedName ? { suggestedName: media.suggestedName } : {}),
              createdAtMs: Date.now(),
            },
          });
        } catch {
          reportUnavailable(message, media, 'persistence_failed');
          continue;
        }
        if (result.success) {
          const parsed = SessionMediaItemV1Schema.safeParse(result.item);
          if (parsed.success) {
            items.push(parsed.data);
          } else {
            reportUnavailable(message, media, 'invalid_persisted_metadata');
          }
        } else {
          reportUnavailable(message, media, result.code);
        }
      }
      return items;
    },
  };
}
