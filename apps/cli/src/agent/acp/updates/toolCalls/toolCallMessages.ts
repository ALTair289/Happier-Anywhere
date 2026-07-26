import type { AgentMessage } from '@/agent/core';

import {
  emitSessionMediaExtractionResult,
  extractAcpMediaContentBlocks,
} from '../../media/extractAcpMediaContentBlocks';
import { attachAcpMetadataToArgs, parseArgsFromContent } from '../content';
import type { AcpToolCallPublication, AcpToolResultPublication } from './types';

export function emitAcpToolCallPublication(
  publication: AcpToolCallPublication,
  emit: (message: AgentMessage) => void,
): void {
  const { snapshot } = publication;
  const args = { ...parseArgsFromContent(snapshot.rawInput) };
  if (!('locations' in args) || Array.isArray(snapshot.locations)) {
    args.locations = Array.isArray(snapshot.locations) ? snapshot.locations : [];
  }
  attachAcpMetadataToArgs(
    args,
    {
      ...(snapshot.title !== null && snapshot.title !== undefined ? { title: snapshot.title } : {}),
      ...(Array.isArray(snapshot.locations) ? { locations: snapshot.locations } : {}),
      ...(snapshot._meta ? { meta: snapshot._meta } : {}),
    },
    typeof snapshot.kind === 'string' ? snapshot.kind : 'unknown',
    snapshot.rawInput,
  );
  const acp = args._acp && typeof args._acp === 'object' && !Array.isArray(args._acp)
    ? args._acp as Record<string, unknown>
    : {};
  args._acp = {
    ...acp,
    snapshotRevision: publication.revision,
    snapshotUpdatedAt: publication.updatedAt,
  };
  emit({
    type: 'tool-call',
    toolName: publication.toolName,
    args,
    callId: publication.callId,
  });
}

export function emitAcpToolResultPublication(
  publication: AcpToolResultPublication,
  emit: (message: AgentMessage) => void,
): void {
  emit({
    type: 'tool-result',
    toolName: publication.toolName,
    result: publication.value,
    callId: publication.callId,
    ...(publication.isError !== undefined ? { isError: publication.isError } : {}),
  });
  emitSessionMediaExtractionResult({
    result: extractAcpMediaContentBlocks(publication.snapshot.rawOutput, {
      source: 'acp-tool-result',
      originSource: 'tool-output',
      toolCallId: publication.callId,
      dedupePrefix: 'acp:tool-result',
    }),
    source: 'acp-tool-result',
    emit,
  });
}
