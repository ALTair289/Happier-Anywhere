import { createHash } from 'node:crypto';

export type ToolCallTranscriptNamespace =
  | Readonly<{ type: 'main' }>
  | Readonly<{ type: 'sidechain'; sidechainId: string }>;

function appendLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  hash.update(String(bytes.byteLength));
  hash.update(':');
  hash.update(bytes);
  hash.update(';');
}

export function createToolCallTranscriptIdentity(params: Readonly<{
  provider: string;
  namespace: ToolCallTranscriptNamespace;
  toolCallId: string;
  message: 'call' | 'result';
}>): string {
  const hash = createHash('sha256');
  appendLengthPrefixed(hash, 'happier-acp-tool-transcript-v1');
  appendLengthPrefixed(hash, params.provider);
  appendLengthPrefixed(hash, params.namespace.type);
  appendLengthPrefixed(hash, params.namespace.type === 'sidechain' ? params.namespace.sidechainId : '');
  appendLengthPrefixed(hash, params.toolCallId);
  appendLengthPrefixed(hash, params.message);
  const digest = hash.digest('base64url');
  return `acp_t${params.message === 'call' ? 'c' : 'r'}_v1_${digest}`;
}
