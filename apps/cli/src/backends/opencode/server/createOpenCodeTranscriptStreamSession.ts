import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

type StreamedTranscriptEphemeralOptions = Readonly<{
  localId: string;
  createdAt: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
  tick?: number;
}>;

type StreamedTranscriptEphemeralDeltaOptions = Readonly<{
  localId: string;
  tick: number;
  baseLength: number;
  createdAt: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
}>;

export type OpenCodeTranscriptStreamSessionSource = Readonly<{
  sendAgentMessage: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageCommitted: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEphemeralOptions,
  ) => void | Promise<void>;
  sendAgentMessageEphemeralDelta?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEphemeralDeltaOptions,
  ) => void | Promise<void>;
  getEphemeralStreamConnectionEpoch?: () => number;
}>;

export type OpenCodeTranscriptStreamSession = StreamedTranscriptWriterSession & Readonly<{
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEphemeralOptions,
  ) => void | Promise<void>;
}>;

function mergeBaseMeta(
  baseMeta: Record<string, unknown>,
  optsMeta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...baseMeta,
    ...(optsMeta ?? {}),
  };
}

export function createOpenCodeTranscriptStreamSession(params: Readonly<{
  session: OpenCodeTranscriptStreamSessionSource;
  baseMeta: Record<string, unknown>;
}>): OpenCodeTranscriptStreamSession {
  return {
    sendAgentMessage: (provider, body, opts) =>
      params.session.sendAgentMessage(provider, body, {
        ...opts,
        meta: mergeBaseMeta(params.baseMeta, opts?.meta),
      }),
    sendAgentMessageCommitted: (provider, body, opts) =>
      params.session.sendAgentMessageCommitted(provider, body, {
        ...opts,
        meta: mergeBaseMeta(params.baseMeta, opts.meta),
      }),
    ...(typeof params.session.enqueueAgentMessageCommitted === 'function'
      ? {
	          enqueueAgentMessageCommitted: (provider, body, opts) =>
	            params.session.enqueueAgentMessageCommitted?.(provider, body, {
	              ...opts,
	              meta: mergeBaseMeta(params.baseMeta, opts.meta),
	            }) ?? Promise.resolve({ persisted: false, delivered: false }),
	        }
      : {}),
    ...(typeof params.session.sendAgentMessageEphemeral === 'function'
      ? {
          sendAgentMessageEphemeral: (provider, body, opts) =>
            params.session.sendAgentMessageEphemeral?.(provider, body, {
              ...opts,
              meta: mergeBaseMeta(params.baseMeta, opts.meta),
            }),
        }
      : {}),
    ...(typeof params.session.sendAgentMessageEphemeralDelta === 'function'
      ? {
          sendAgentMessageEphemeralDelta: (
            provider: ACPProvider,
            body: ACPMessageData,
            opts: StreamedTranscriptEphemeralDeltaOptions,
          ) => void params.session.sendAgentMessageEphemeralDelta?.(provider, body, {
            ...opts,
            meta: mergeBaseMeta(params.baseMeta, opts.meta),
          }),
        }
      : {}),
    ...(typeof params.session.getEphemeralStreamConnectionEpoch === 'function'
      ? {
          getEphemeralStreamConnectionEpoch: () => params.session.getEphemeralStreamConnectionEpoch?.() ?? 0,
        }
      : {}),
  };
}
