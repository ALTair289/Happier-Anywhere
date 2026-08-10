type CodexForwardCursorV1 = Readonly<{
  v: 1;
  kind: 'codexForward';
  fileRelPath: string;
  offsetBytes: number;
}>;

type CodexAppServerForwardCursorV2 = Readonly<{
  v: 2;
  kind: 'codexForwardAppServer';
  updatedAtMs: number;
  previewText: string | null;
}>;

type CodexMergedForwardCursorV3 = Readonly<{
  v: 3;
  kind: 'codexForwardMerged';
  lastCreatedAtMs: number;
  lastId: string | null;
}>;

type CodexStreamVectorForwardCursorV4 = Readonly<{
  v: 4;
  kind: 'codexForwardStreamVector';
  streams: readonly Readonly<{
    fileRelPath: string;
    nextOffsetBytes: number;
    subIndex?: number;
  }>[];
}>;

export type CodexDurableStreamForwardProgress = Readonly<{
  fileRelPath: string;
  nextOffsetBytes: number;
  subIndex: number;
  fingerprintOffsetBytes: number;
  deferredUserResponseOffsetBytes?: number;
  deliveredUserResponseOffsetBytes?: number;
  fileIdentity: string;
  contentFingerprint: string;
}>;

type CodexDurableStreamVectorForwardCursorV5 = Readonly<{
  v: 5;
  kind: 'codexForwardStreamVector';
  streams: readonly CodexDurableStreamForwardProgress[];
}>;

export type CodexDirectForwardCursor =
  | CodexForwardCursorV1
  | CodexAppServerForwardCursorV2
  | CodexMergedForwardCursorV3
  | CodexStreamVectorForwardCursorV4
  | CodexDurableStreamVectorForwardCursorV5;

export function encodeCodexDirectForwardCursor(value: CodexDirectForwardCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCodexDirectForwardCursor(raw: string): CodexDirectForwardCursor | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v === 1 && record.kind === 'codexForward') {
      const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
      const offsetBytes = typeof record.offsetBytes === 'number' && Number.isFinite(record.offsetBytes) ? Math.trunc(record.offsetBytes) : NaN;
      if (!fileRelPath.trim()) return null;
      if (!Number.isFinite(offsetBytes) || offsetBytes < 0) return null;
      return { v: 1, kind: 'codexForward', fileRelPath, offsetBytes };
    }
    if (record.v === 2 && record.kind === 'codexForwardAppServer') {
      const updatedAtMs = typeof record.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
        ? Math.trunc(record.updatedAtMs)
        : NaN;
      const previewText = typeof record.previewText === 'string' && record.previewText.trim().length > 0
        ? record.previewText.trim()
        : null;
      if (!Number.isFinite(updatedAtMs) || updatedAtMs < 0) return null;
      return { v: 2, kind: 'codexForwardAppServer', updatedAtMs, previewText };
    }
    if (record.v === 3 && record.kind === 'codexForwardMerged') {
      const lastCreatedAtMs = typeof record.lastCreatedAtMs === 'number' && Number.isFinite(record.lastCreatedAtMs)
        ? Math.trunc(record.lastCreatedAtMs)
        : NaN;
      const lastId = typeof record.lastId === 'string' && record.lastId.trim().length > 0
        ? record.lastId
        : null;
      if (!Number.isFinite(lastCreatedAtMs) || lastCreatedAtMs < 0) return null;
      return { v: 3, kind: 'codexForwardMerged', lastCreatedAtMs, lastId };
    }
    if (record.v === 4 && record.kind === 'codexForwardStreamVector') {
      const rawStreams = Array.isArray(record.streams) ? record.streams : [];
      const streams = rawStreams
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const streamRecord = entry as Record<string, unknown>;
          const fileRelPath = typeof streamRecord.fileRelPath === 'string' ? streamRecord.fileRelPath.trim() : '';
          const nextOffsetBytes = typeof streamRecord.nextOffsetBytes === 'number' && Number.isFinite(streamRecord.nextOffsetBytes)
            ? Math.trunc(streamRecord.nextOffsetBytes)
            : NaN;
          const subIndex = typeof streamRecord.subIndex === 'number' && Number.isFinite(streamRecord.subIndex)
            ? Math.trunc(streamRecord.subIndex)
            : 0;
          if (!fileRelPath || !Number.isFinite(nextOffsetBytes) || nextOffsetBytes < 0 || subIndex < 0) return null;
          return { fileRelPath, nextOffsetBytes, subIndex };
        })
        .filter((entry): entry is { fileRelPath: string; nextOffsetBytes: number; subIndex: number } => entry !== null);
      return { v: 4, kind: 'codexForwardStreamVector', streams };
    }
    if (record.v === 5 && record.kind === 'codexForwardStreamVector') {
      const rawStreams = Array.isArray(record.streams) ? record.streams : [];
      const streams = rawStreams
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const streamRecord = entry as Record<string, unknown>;
          const fileRelPath = typeof streamRecord.fileRelPath === 'string' ? streamRecord.fileRelPath.trim() : '';
          const nextOffsetBytes = typeof streamRecord.nextOffsetBytes === 'number' && Number.isFinite(streamRecord.nextOffsetBytes)
            ? Math.trunc(streamRecord.nextOffsetBytes)
            : NaN;
          const subIndex = typeof streamRecord.subIndex === 'number' && Number.isFinite(streamRecord.subIndex)
            ? Math.trunc(streamRecord.subIndex)
            : NaN;
          const fingerprintOffsetBytes = typeof streamRecord.fingerprintOffsetBytes === 'number'
            && Number.isFinite(streamRecord.fingerprintOffsetBytes)
            ? Math.trunc(streamRecord.fingerprintOffsetBytes)
            : NaN;
          const fileIdentity = typeof streamRecord.fileIdentity === 'string' ? streamRecord.fileIdentity.trim() : '';
          const contentFingerprint = typeof streamRecord.contentFingerprint === 'string'
            ? streamRecord.contentFingerprint.trim()
            : '';
          const deferredUserResponseOffsetBytes = typeof streamRecord.deferredUserResponseOffsetBytes === 'number'
            && Number.isFinite(streamRecord.deferredUserResponseOffsetBytes)
            ? Math.trunc(streamRecord.deferredUserResponseOffsetBytes)
            : undefined;
          const deliveredUserResponseOffsetBytes = typeof streamRecord.deliveredUserResponseOffsetBytes === 'number'
            && Number.isFinite(streamRecord.deliveredUserResponseOffsetBytes)
            ? Math.trunc(streamRecord.deliveredUserResponseOffsetBytes)
            : undefined;
          if (
            !fileRelPath
            || !Number.isSafeInteger(nextOffsetBytes)
            || nextOffsetBytes < 0
            || !Number.isSafeInteger(subIndex)
            || subIndex < 0
            || !Number.isSafeInteger(fingerprintOffsetBytes)
            || fingerprintOffsetBytes < nextOffsetBytes
            || (deferredUserResponseOffsetBytes !== undefined
              && (!Number.isSafeInteger(deferredUserResponseOffsetBytes)
                || deferredUserResponseOffsetBytes !== nextOffsetBytes))
            || (deliveredUserResponseOffsetBytes !== undefined
              && (!Number.isSafeInteger(deliveredUserResponseOffsetBytes)
                || deliveredUserResponseOffsetBytes < 0
                || deliveredUserResponseOffsetBytes >= nextOffsetBytes))
            || !/^[a-f0-9]{64}$/.test(fileIdentity)
            || !/^[a-f0-9]{64}$/.test(contentFingerprint)
          ) return null;
          return {
            fileRelPath,
            nextOffsetBytes,
            subIndex,
            fingerprintOffsetBytes,
            fileIdentity,
            contentFingerprint,
            ...(deferredUserResponseOffsetBytes === undefined ? {} : { deferredUserResponseOffsetBytes }),
            ...(deliveredUserResponseOffsetBytes === undefined ? {} : { deliveredUserResponseOffsetBytes }),
          };
        })
        .filter((entry): entry is CodexDurableStreamForwardProgress => entry !== null);
      if (streams.length !== rawStreams.length) return null;
      if (new Set(streams.map((entry) => entry.fileRelPath)).size !== streams.length) return null;
      return { v: 5, kind: 'codexForwardStreamVector', streams };
    }
    return null;
  } catch {
    return null;
  }
}
