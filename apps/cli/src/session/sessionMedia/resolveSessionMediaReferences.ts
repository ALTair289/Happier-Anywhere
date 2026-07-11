import { lstat, open, realpath, stat } from 'node:fs/promises';
import { relative } from 'node:path';

import type { SessionMediaReferenceV1 } from '@happier-dev/protocol';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

import { resolveSessionMediaMimeType } from './sessionMediaMime';

async function readPrefix(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(maxBytes);
    const result = await handle.read(bytes, 0, maxBytes, 0);
    return bytes.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function toPortableWorkspacePath(workingDirectory: string, resolvedPath: string): Promise<string | null> {
  const [canonicalWorkspace, canonicalPath] = await Promise.all([
    realpath(workingDirectory),
    realpath(resolvedPath),
  ]).catch(() => [] as const);
  if (!canonicalWorkspace || !canonicalPath) return null;
  const value = relative(canonicalWorkspace, canonicalPath).replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return value;
}

export async function resolveSessionMediaReferences(input: Readonly<{
  paths: readonly string[];
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  maxBytes: number;
}>): Promise<SessionMediaReferenceV1[]> {
  const references: SessionMediaReferenceV1[] = [];
  const seen = new Set<string>();
  for (const path of input.paths.slice(0, 64)) {
    try {
      const authorization = authorizeFilesystemPath({
        targetPath: path,
        defaultDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy,
      });
      if (!authorization.valid) continue;
      const portablePath = await toPortableWorkspacePath(input.workingDirectory, authorization.resolvedPath);
      if (!portablePath || seen.has(portablePath)) continue;
      const sourceLstat = await lstat(authorization.resolvedPath).catch(() => null);
      if (!sourceLstat?.isFile() || sourceLstat.isSymbolicLink()) continue;
      const sourceStat = await stat(authorization.resolvedPath).catch(() => null);
      if (!sourceStat || sourceStat.size <= 0 || sourceStat.size > input.maxBytes) continue;
      const mimeType = resolveSessionMediaMimeType({
        bytes: await readPrefix(authorization.resolvedPath, 4096),
        suggestedName: portablePath,
      });
      if (!mimeType) continue;
      seen.add(portablePath);
      references.push({
        mediaKind: 'image',
        path: portablePath,
        mimeType,
        sizeBytes: sourceStat.size,
      });
    } catch {
      // Reference metadata is best-effort and must never fail the generated output.
    }
  }
  return references;
}

export function sanitizeSessionMediaDescription(value: string | undefined): string | undefined {
  const sanitized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16_384)
    .trim();
  return sanitized || undefined;
}
