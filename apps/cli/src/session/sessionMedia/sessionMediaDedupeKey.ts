import { createHash } from 'node:crypto';

import type { SessionMediaSource } from '@/agent/core/AgentMessage';

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function resolveSessionMediaDedupeKey(media: SessionMediaSource): string {
  if (media.dedupeKey) return `explicit:sha256:${sha256Text(media.dedupeKey)}`;

  const origin = media.origin;
  const originSource = typeof origin.source === 'string' ? origin.source : 'unknown';
  const stableId =
    (typeof origin.providerEventId === 'string' ? origin.providerEventId : null) ??
    (typeof origin.generationId === 'string' ? origin.generationId : null) ??
    (typeof origin.toolCallId === 'string' ? origin.toolCallId : null) ??
    (typeof origin.providerFileId === 'string' ? origin.providerFileId : null) ??
    'media';
  const stableIdHash = sha256Text(stableId);
  const contentIndex = typeof origin.contentIndex === 'number' ? origin.contentIndex : 'unknown';

  if (media.kind === 'base64') {
    return `${originSource}:id-sha256:${stableIdHash}:${contentIndex}:${media.mimeType}:sha256:${sha256Text(media.data)}`;
  }
  if (media.kind === 'local-file') {
    // A provider extension and the terminal tool output can independently surface the
    // same generated file. Correlate by the provider call/generation while ignoring
    // source/content-index differences, so a later distinct call may reuse the path.
    const correlationId =
      (typeof origin.toolCallId === 'string' ? origin.toolCallId : null) ??
      (typeof origin.generationId === 'string' ? origin.generationId : null) ??
      (typeof origin.providerEventId === 'string' ? origin.providerEventId : null) ??
      (typeof origin.providerFileId === 'string' ? origin.providerFileId : null) ??
      'media';
    return `local-file:${sha256Text(correlationId)}:${sha256Text(media.path)}`;
  }
  return `${originSource}:id-sha256:${stableIdHash}:${contentIndex}:local-uri:${sha256Text(media.uri)}`;
}
