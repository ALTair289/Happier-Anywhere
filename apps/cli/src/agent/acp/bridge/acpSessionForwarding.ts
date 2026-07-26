import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

export type AcpSendFn = (
  provider: ACPProvider,
  body: ACPMessageData,
  opts?: { localId?: string; meta?: Record<string, unknown> },
) => void;

export function namespaceSidechainCallId(params: { sidechainId: string; toolCallId: string }): string {
  // Avoid collisions with main-thread tool ids: namespace under the parent tool-call id.
  return `sc:${params.sidechainId}:${params.toolCallId}`;
}
