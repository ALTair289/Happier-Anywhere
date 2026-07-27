import {
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
  type AcpExtensionRegistration,
} from '@/agent/acp/connection/types';
import type { AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  cursorGenerateImageNotificationSchema,
  type CursorGenerateImageNotification,
} from './schemas';

type CursorGeneratedMediaProjection = Readonly<{
  emit: (message: AgentMessage) => void;
}>;

function projectCursorGeneratedMedia(
  payload: CursorGenerateImageNotification,
  projection: CursorGeneratedMediaProjection,
): void {
  const filePath = payload.filePath;
  if (!filePath || filePath.trim().length === 0) return;
  const toolCallId = payload.toolCallId;
  const correlationHash = createHash('sha256').update(toolCallId ?? filePath).digest('hex');
  try {
    projection.emit({
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{
        kind: 'local-file',
        path: filePath,
        suggestedName: basename(filePath),
        ...(payload.description ? { description: payload.description } : {}),
        ...(payload.referenceImagePaths?.length
          ? { referenceImagePaths: [...payload.referenceImagePaths] }
          : {}),
        origin: {
          source: 'provider-generated',
          agentId: 'cursor',
          ...(toolCallId ? { toolCallId } : {}),
          providerEventId: `cursor-generate-image:${correlationHash}`,
        },
      }],
    });
  } catch (error) {
    logger.debug('[CursorACP] Generated media unavailable after projection (non-fatal)', {
      correlationHash,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

export function createCursorGeneratedMediaDescriptors(
  projection: CursorGeneratedMediaProjection,
): ReadonlyArray<AcpExtensionRegistration> {
  return [
    defineAcpExtensionRequest({
      method: 'cursor/generate_image',
      params: cursorGenerateImageNotificationSchema,
      handler: async (payload) => {
        projectCursorGeneratedMedia(payload, projection);
        return {};
      },
    }),
    defineAcpExtensionNotification({
      method: 'cursor/generate_image',
      params: cursorGenerateImageNotificationSchema,
      handler: async (payload) => {
        projectCursorGeneratedMedia(payload, projection);
      },
    }),
  ];
}
