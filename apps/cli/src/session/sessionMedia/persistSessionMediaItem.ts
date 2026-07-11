import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configuration } from '@/configuration';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { resolveWorkspaceFileUploadTarget } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';
import { ensureSessionMediaIgnoreRule } from '@/transfers/sessionMedia/ensureSessionMediaIgnoreRule';
import { persistedSessionMediaCategoryToTransferCategory } from '@/transfers/sessionMedia/sessionMediaCategories';
import {
    DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG,
    type SessionMediaTransferConfig,
} from '@/transfers/sessionMedia/sessionMediaConfig';
import { resolveConfiguredSessionMediaTransferTarget } from '@/transfers/sessionMedia/resolveSessionMediaTransferTarget';
import {
    normalizeSessionMediaPathSegment,
    sanitizeSessionMediaFileName,
    withSessionMediaFileExtension,
} from '@/transfers/sessionMedia/sanitizeSessionMediaFileName';

import { adoptSessionMediaSourceFile } from './adoptSessionMediaSourceFile';
import type {
    SessionMediaIngestionSource,
    SessionMediaItemV1,
    SessionMediaOrigin,
} from './sessionMediaIngestionSource';
import {
    extensionForSessionMediaMimeType,
    resolveSessionMediaMimeType,
    type SupportedSessionMediaMimeType,
} from './sessionMediaMime';
import {
    resolveSessionMediaReferences,
    sanitizeSessionMediaDescription,
} from './resolveSessionMediaReferences';

export type PersistSessionMediaInput = Readonly<{
    sessionId: string;
    messageLocalId: string;
    role: 'input' | 'output';
    category: 'attachment' | 'generated' | 'tool-artifact';
    source: SessionMediaIngestionSource;
    origin: SessionMediaOrigin;
    description?: string;
    referenceImagePaths?: readonly string[];
    suggestedName?: string;
    createdAtMs?: number;
}>;

export type PersistSessionMediaResult =
    | Readonly<{ success: true; item: SessionMediaItemV1 }>
    | PersistSessionMediaFailure;

type PersistSessionMediaFailure = Readonly<{ success: false; code: string; error: string }>;

type PreparedMediaSource =
    | Readonly<{
        kind: 'buffer';
        bytes: Buffer;
        mimeType: SupportedSessionMediaMimeType;
        suggestedName?: string;
    }>
    | Readonly<{
        kind: 'file';
        path: string;
        sizeBytes: number;
        mimeType: SupportedSessionMediaMimeType;
        suggestedName?: string;
    }>;

type ImageDimensions = Readonly<{
    width: number;
    height: number;
}>;

function failure(code: string, error: string): PersistSessionMediaFailure {
    return { success: false, code, error };
}

function boundedOriginValue(value: string | undefined): string | undefined {
    const normalized = value?.trim().slice(0, 16_384).trim();
    return normalized || undefined;
}

function sanitizeSessionMediaOrigin(origin: SessionMediaOrigin): SessionMediaOrigin {
    const sanitized: {
        source: SessionMediaOrigin['source'];
        agentId?: string;
        toolCallId?: string;
        generationId?: string;
        providerEventId?: string;
        providerFileId?: string;
    } = {
        source: origin.source,
    };
    const agentId = boundedOriginValue(origin.agentId);
    const toolCallId = boundedOriginValue(origin.toolCallId);
    const generationId = boundedOriginValue(origin.generationId);
    const providerEventId = boundedOriginValue(origin.providerEventId);
    const providerFileId = boundedOriginValue(origin.providerFileId);
    if (agentId) sanitized.agentId = agentId;
    if (toolCallId) sanitized.toolCallId = toolCallId;
    if (generationId) sanitized.generationId = generationId;
    if (providerEventId) sanitized.providerEventId = providerEventId;
    if (providerFileId) sanitized.providerFileId = providerFileId;
    return sanitized;
}

function isPersistSessionMediaFailure(
    value: PreparedMediaSource | PersistSessionMediaFailure,
): value is PersistSessionMediaFailure {
    return 'success' in value && value.success === false;
}

function joinSessionMediaPath(...segments: readonly string[]): string {
    return segments
        .map((segment) => String(segment ?? '').replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, ''))
        .filter((segment) => segment.length > 0)
        .join('/');
}

async function hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

function readPositiveImageDimension(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

async function readPreparedImageDimensions(source: PreparedMediaSource): Promise<ImageDimensions | null> {
    try {
        const sharp = (await import('sharp')).default;
        const image = source.kind === 'buffer'
            ? sharp(source.bytes, { failOn: 'none' })
            : sharp(source.path, { failOn: 'none' });
        const metadata = await image.metadata();
        const width = readPositiveImageDimension(metadata.width);
        const height = readPositiveImageDimension(metadata.height);
        return width && height ? { width, height } : null;
    } catch {
        return null;
    }
}

async function readFilePrefix(path: string, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of createReadStream(path, { start: 0, end: Math.max(0, maxBytes - 1) })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(bytes);
        totalBytes += bytes.byteLength;
        if (totalBytes >= maxBytes) break;
    }
    return Buffer.concat(chunks).subarray(0, maxBytes);
}

function resolveMimeType(input: Readonly<{
    bytes: Uint8Array;
    declaredMimeType?: string;
    suggestedName?: string;
}>): SupportedSessionMediaMimeType | null {
    return resolveSessionMediaMimeType(input);
}

function resolveSourceSuggestedName(source: SessionMediaIngestionSource, fallback?: string): string {
    if (source.suggestedName) return source.suggestedName;
    if (fallback) return fallback;
    if (source.kind === 'local-file') return basename(source.path);
    if (source.kind === 'local-uri') {
        try {
            if (new URL(source.uri).protocol === 'file:') {
                return basename(fileURLToPath(source.uri));
            }
        } catch {
            return 'image';
        }
    }
    return 'image';
}

async function prepareSource(input: Readonly<{
    source: SessionMediaIngestionSource;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    maxBytes: number;
    suggestedName?: string;
}>): Promise<PreparedMediaSource | PersistSessionMediaFailure> {
    if (input.source.kind === 'provider-file') {
        return failure('provider_file_unavailable', 'Provider file media requires a provider-owned downloader before it can be persisted');
    }

    if (input.source.kind === 'base64') {
        let bytes: Buffer;
        try {
            bytes = Buffer.from(input.source.data, 'base64');
        } catch {
            return failure('invalid_base64', 'Media source base64 data is invalid');
        }
        if (bytes.byteLength > input.maxBytes) {
            return failure('media_too_large', 'Media exceeds the configured size limit');
        }
        const suggestedName = resolveSourceSuggestedName(input.source, input.suggestedName);
        const mimeType = resolveMimeType({
            bytes,
            declaredMimeType: input.source.mimeType,
            suggestedName,
        });
        if (!mimeType) {
            return failure('unsupported_mime', 'Media MIME type is unsupported');
        }
        return {
            kind: 'buffer',
            bytes,
            mimeType,
            suggestedName,
        };
    }

    const localPathResult = input.source.kind === 'local-uri'
        ? resolveLocalUriPath(input.source.uri)
        : { success: true as const, path: input.source.path };
    if (!localPathResult.success) {
        return failure(localPathResult.code, localPathResult.error);
    }

    const sourceAuthorization = authorizeFilesystemPath({
        targetPath: localPathResult.path,
        defaultDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy ?? { kind: 'osUser' },
    });
    if (!sourceAuthorization.valid) {
        return failure('unauthorized_source_path', sourceAuthorization.error);
    }

    const sourceLstat = await lstat(sourceAuthorization.resolvedPath).catch(() => null);
    if (!sourceLstat || !sourceLstat.isFile() || sourceLstat.isSymbolicLink()) {
        return failure('invalid_source_file', 'Media source must be a regular file');
    }
    const sourceStat = await stat(sourceAuthorization.resolvedPath);
    if (sourceStat.size > input.maxBytes) {
        return failure('media_too_large', 'Media exceeds the configured size limit');
    }

    const suggestedName = resolveSourceSuggestedName(input.source, input.suggestedName);
    const prefix = await readFilePrefix(sourceAuthorization.resolvedPath, 4096);
    const mimeType = resolveMimeType({
        bytes: prefix,
        declaredMimeType: input.source.mimeType,
        suggestedName,
    });
    if (!mimeType) {
        return failure('unsupported_mime', 'Media MIME type is unsupported');
    }
    return {
        kind: 'file',
        path: sourceAuthorization.resolvedPath,
        sizeBytes: sourceStat.size,
        mimeType,
        suggestedName,
    };
}

function resolveLocalUriPath(uri: string): Readonly<{ success: true; path: string } | { success: false; code: string; error: string }> {
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        return { success: false, code: 'unsupported_uri', error: 'Media URI is invalid' };
    }
    if (parsed.protocol !== 'file:') {
        return { success: false, code: 'unsupported_uri', error: 'Only local file URIs are supported for session media persistence' };
    }
    return { success: true, path: fileURLToPath(parsed) };
}

function buildStoredFileName(input: Readonly<{
    mediaId: string;
    category: PersistSessionMediaInput['category'];
    source: SessionMediaIngestionSource;
    suggestedName?: string;
    mimeType: SupportedSessionMediaMimeType;
}>): string {
    const fallback = input.category === 'tool-artifact' ? 'artifact-image' : 'generated-image';
    const rawName = resolveSourceSuggestedName(input.source, input.suggestedName || fallback);
    const safeName = sanitizeSessionMediaFileName(rawName, fallback);
    const nameWithExtension = withSessionMediaFileExtension(
        safeName,
        extensionForSessionMediaMimeType(input.mimeType),
    );
    return `${input.mediaId}-${nameWithExtension}`;
}

export async function persistSessionMediaItem(params: Readonly<{
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    pathAllowanceRegistry: TransferPathAllowanceRegistry;
    config?: SessionMediaTransferConfig;
    maxBytes?: number;
    sessionRpcTransferMaxBytes?: number | null;
    input: PersistSessionMediaInput;
}>): Promise<PersistSessionMediaResult> {
    const messageLocalId = normalizeSessionMediaPathSegment(params.input.messageLocalId);
    if (!messageLocalId) {
        return failure('invalid_message_local_id', 'Invalid messageLocalId');
    }

    const config = params.config ?? DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG;
    const transferCategory = persistedSessionMediaCategoryToTransferCategory(params.input.category);
    const tempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());
    const resolvedTarget = resolveConfiguredSessionMediaTransferTarget({
        config,
        tempUploadRoot,
        workingDirectory: params.workingDirectory,
        accessPolicy: params.accessPolicy,
        category: transferCategory,
    });
    if (!resolvedTarget.success) {
        const code = resolvedTarget.error.startsWith('Access denied')
            ? 'unauthorized_media_path'
            : 'invalid_media_target';
        return failure(code, resolvedTarget.error);
    }

    const maxBytes = params.maxBytes ?? configuration.filesUploadMaxFileBytes;
    const prepared = await prepareSource({
        source: params.input.source,
        workingDirectory: params.workingDirectory,
        accessPolicy: params.accessPolicy,
        maxBytes,
        suggestedName: params.input.suggestedName,
    });
    if (isPersistSessionMediaFailure(prepared)) {
        return prepared;
    }

    const mediaId = randomUUID();
    const fileName = buildStoredFileName({
        mediaId,
        category: params.input.category,
        source: params.input.source,
        suggestedName: prepared.suggestedName,
        mimeType: prepared.mimeType,
    });
    const mediaPath = joinSessionMediaPath(resolvedTarget.uploadBasePath, messageLocalId, fileName);
    const sizeBytes = prepared.kind === 'buffer' ? prepared.bytes.byteLength : prepared.sizeBytes;
    const uploadTarget = resolveWorkspaceFileUploadTarget({
        workingDirectory: params.workingDirectory,
        accessPolicy: params.accessPolicy,
        path: mediaPath,
        sizeBytes,
        overwrite: false,
        additionalAllowedWriteDirs: resolvedTarget.target.additionalAllowedWriteDirs,
        sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
    });
    if (!uploadTarget.success) {
        return failure('unauthorized_media_path', uploadTarget.error);
    }

    await mkdir(dirname(uploadTarget.target.destPath), { recursive: true });
    if (prepared.kind === 'buffer') {
        await writeFile(uploadTarget.target.destPath, prepared.bytes);
    } else {
        await adoptSessionMediaSourceFile({
            sourcePath: prepared.path,
            destinationPath: uploadTarget.target.destPath,
        });
    }

    const sha256 = prepared.kind === 'buffer'
        ? createHash('sha256').update(prepared.bytes).digest('hex')
        : await hashFile(uploadTarget.target.destPath);
    const dimensions = await readPreparedImageDimensions(prepared);
    const description = sanitizeSessionMediaDescription(params.input.description);
    const references = params.input.referenceImagePaths?.length
        ? await resolveSessionMediaReferences({
            paths: params.input.referenceImagePaths,
            workingDirectory: params.workingDirectory,
            accessPolicy: params.accessPolicy ?? { kind: 'osUser' },
            maxBytes,
        })
        : [];

    try {
        await ensureSessionMediaIgnoreRule({
            workingDirectory: params.workingDirectory,
            config,
        });
    } catch {
        // Ignore-rule writes are best effort and must not prevent media persistence.
    }

    params.pathAllowanceRegistry.setAdditionalAllowedReadDirs(resolvedTarget.target.additionalAllowedReadDirs);
    params.pathAllowanceRegistry.setAdditionalAllowedWriteDirs(resolvedTarget.target.additionalAllowedWriteDirs);

    return {
        success: true,
        item: {
            id: mediaId,
            role: params.input.role,
            category: params.input.category,
            mediaKind: 'image',
            mimeType: prepared.mimeType,
            name: fileName.slice(mediaId.length + 1),
            path: mediaPath,
            sizeBytes,
            ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
            sha256,
            ...(typeof params.input.createdAtMs === 'number' ? { createdAtMs: params.input.createdAtMs } : {}),
            ...(description ? { description } : {}),
            ...(references.length > 0 ? { references } : {}),
            origin: sanitizeSessionMediaOrigin(params.input.origin),
        },
    };
}
