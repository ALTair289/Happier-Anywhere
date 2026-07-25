import { z } from 'zod';
import { PendingLocalIdSchema } from './sessionMessages/pendingLocalId.js';

export const SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND = 'sessionAttachmentUpload';

type MetadataRecord = Record<string, unknown>;

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asRecordArray(value: unknown): MetadataRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasUploadedAttachmentProvenance(value: unknown): boolean {
  return asRecord(value)?.kind === SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND;
}

function normalizeSessionAttachmentUploadPath(value: unknown): string | null {
  const path = readString(value);
  if (!path || path.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;

  const normalized = path.replace(/[\\]+/g, '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;

  if (
    segments.length >= 5
    && segments[0] === '.happier'
    && segments[1] === 'uploads'
    && segments[2] === 'messages'
  ) {
    return normalized;
  }

  const tempRootIndex = segments.findIndex((segment, index) => {
    return segment === 'happier'
      && segments[index + 1] === 'uploads'
      && typeof segments[index + 2] === 'string'
      && segments[index + 3] === 'messages'
      && typeof segments[index + 4] === 'string'
      && typeof segments[index + 5] === 'string';
  });
  return tempRootIndex >= 0 ? normalized : null;
}

function isImageAttachment(entry: MetadataRecord): boolean {
  const kind = readString(entry.kind);
  const type = readString(entry.type);
  const mimeType = readString(entry.mimeType);
  return kind === 'image'
    || type === 'image'
    || type === 'localImage'
    || mimeType?.toLowerCase().startsWith('image/') === true;
}

function readAttachmentEnvelope(value: MetadataRecord): MetadataRecord[] {
  const happier = asRecord(value.happier);
  if (happier?.kind !== 'attachments.v1') return [];
  const payload = asRecord(happier.payload);
  return asRecordArray(payload?.attachments);
}

export function readAttachmentEnvelopeLocalImagePaths(value: unknown): ReadonlySet<string> {
  const meta = asRecord(value);
  const paths = new Set<string>();
  if (!meta) return paths;

  for (const attachment of readAttachmentEnvelope(meta)) {
    if (!isImageAttachment(attachment)) continue;
    const normalizedPath = normalizeSessionAttachmentUploadPath(attachment.path);
    if (normalizedPath) {
      paths.add(normalizedPath);
    }
  }

  return paths;
}

function sanitizeStructuredAttachments(
  value: unknown,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }> = {},
): MetadataRecord[] {
  const attachments: MetadataRecord[] = [];
  for (const attachment of asRecordArray(value)) {
    if (!isImageAttachment(attachment)) continue;

    const localPath = readString(attachment.localPath ?? attachment.path);
    if (localPath) {
      if (!hasUploadedAttachmentProvenance(attachment.provenance)) continue;
      const normalizedLocalPath = normalizeSessionAttachmentUploadPath(localPath);
      if (!normalizedLocalPath) continue;
      if (!options.allowedLocalImagePaths?.has(normalizedLocalPath)) continue;
      attachments.push({
        ...attachment,
        localPath: normalizedLocalPath,
        path: normalizeSessionAttachmentUploadPath(attachment.path) ?? normalizedLocalPath,
        provenance: {
          ...asRecord(attachment.provenance),
          kind: SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
        },
      });
      continue;
    }

    const url = readString(attachment.url);
    if (url) {
      attachments.push({
        ...attachment,
        url,
      });
    }
  }
  return attachments;
}

export const HappierStructuredInputV1EnvelopeSchema = z.object({
  v: z.literal(1).default(1),
  vendorPluginMentions: z.array(z.record(z.string(), z.unknown())).optional(),
  skillMentions: z.array(z.record(z.string(), z.unknown())).optional(),
  imageInputs: z.array(z.record(z.string(), z.unknown())).optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
}).passthrough();
export type HappierStructuredInputV1Envelope = z.infer<typeof HappierStructuredInputV1EnvelopeSchema>;

export function sanitizeHappierStructuredInputV1(
  value: unknown,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }> = {},
): HappierStructuredInputV1Envelope | null {
  const envelope = asRecord(value);
  if (!envelope) return null;

  const vendorPluginMentions = asRecordArray(envelope.vendorPluginMentions);
  const skillMentions = asRecordArray(envelope.skillMentions);
  const imageInputs = sanitizeStructuredAttachments(envelope.imageInputs, options);
  const attachments = sanitizeStructuredAttachments(envelope.attachments, options);
  const sanitized: MetadataRecord = {
    ...envelope,
    v: 1,
  };
  if (vendorPluginMentions.length > 0) {
    sanitized.vendorPluginMentions = vendorPluginMentions;
  } else {
    delete sanitized.vendorPluginMentions;
  }
  if (skillMentions.length > 0) {
    sanitized.skillMentions = skillMentions;
  } else {
    delete sanitized.skillMentions;
  }
  if (imageInputs.length > 0) {
    sanitized.imageInputs = imageInputs;
  } else {
    delete sanitized.imageInputs;
  }
  if (attachments.length > 0) {
    sanitized.attachments = attachments;
  } else {
    delete sanitized.attachments;
  }
  return HappierStructuredInputV1EnvelopeSchema.parse(sanitized);
}

export function sanitizeSessionUserMessageSendMeta(
  value: MetadataRecord,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }> = {},
): MetadataRecord {
  const meta: MetadataRecord = { ...value };
  const structuredInput = sanitizeHappierStructuredInputV1(meta.happierStructuredInputV1, options);
  if (structuredInput) {
    meta.happierStructuredInputV1 = structuredInput;
  } else if (Object.prototype.hasOwnProperty.call(meta, 'happierStructuredInputV1')) {
    delete meta.happierStructuredInputV1;
  }
  return meta;
}

export const SessionUserMessageSendMetaSchema = z
  .record(z.string(), z.unknown())
  .transform((value) => sanitizeSessionUserMessageSendMeta(value));
export type SessionUserMessageSendMeta = z.infer<typeof SessionUserMessageSendMetaSchema>;

export const SessionUserMessageSendRequestSchema = z.object({
  text: z.string().min(1),
  localId: PendingLocalIdSchema.optional(),
  meta: SessionUserMessageSendMetaSchema.default({}),
}).passthrough();
export type SessionUserMessageSendRequest = z.infer<typeof SessionUserMessageSendRequestSchema>;

const SessionUserMessageSendSuccessResponseSchema = z.object({
  ok: z.literal(true),
  providerAcceptancePending: z.boolean().optional(),
}).passthrough();

const SessionUserMessageSendErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  errorCode: z.string().min(1),
}).passthrough();

export const SessionUserMessageSendResponseSchema = z.union([
  SessionUserMessageSendSuccessResponseSchema,
  SessionUserMessageSendErrorResponseSchema,
]);
export type SessionUserMessageSendResponse = z.infer<typeof SessionUserMessageSendResponseSchema>;
