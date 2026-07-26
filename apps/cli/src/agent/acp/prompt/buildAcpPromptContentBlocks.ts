import type { ContentBlock } from '@agentclientprotocol/sdk';
import { sanitizeSessionUserMessageSendMeta } from '@happier-dev/protocol';

import { readTrustedSessionAttachmentLocalImages } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function readNonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePath(value: unknown): string | null {
  const candidate = readNonBlankString(value);
  return candidate ? candidate.replace(/[\\]+/g, '/') : null;
}

export async function buildAcpPromptContentBlocks(params: Readonly<{
  cwd: string;
  text: string;
  metadata?: unknown;
}>): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [{ type: 'text', text: params.text }];
  const metadata = asRecord(params.metadata);
  if (!metadata) return blocks;

  const trustedImages = await readTrustedSessionAttachmentLocalImages({
    cwd: params.cwd,
    metadata,
  });
  if (trustedImages.size === 0) return blocks;
  const trustedPaths = new Set(trustedImages.keys());

  const sanitized = sanitizeSessionUserMessageSendMeta(metadata, {
    allowedLocalImagePaths: trustedPaths,
  });
  const structured = asRecord(sanitized.happierStructuredInputV1);
  const inputs = Array.isArray(structured?.imageInputs)
    ? structured.imageInputs
    : Array.isArray(structured?.attachments) ? structured.attachments : [];

  const emitted = new Set<string>();
  for (const input of inputs) {
    const record = asRecord(input);
    if (!record) continue;
    const localPath = normalizePath(record.localPath ?? record.path);
    const mimeType = readNonBlankString(record.mimeType);
    if (!localPath || !trustedPaths.has(localPath) || !mimeType?.toLowerCase().startsWith('image/')) continue;
    if (emitted.has(localPath)) continue;
    emitted.add(localPath);
    const data = trustedImages.get(localPath)?.toString('base64');
    if (!data) continue;
    blocks.push({ type: 'image', data, mimeType });
  }
  return blocks;
}
