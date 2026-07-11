import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { persistSessionMediaItem } from './persistSessionMediaItem';
import type { SessionMediaOrigin } from './sessionMediaIngestionSource';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { describe, expect, it } from 'vitest';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);
const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const nonImageBytes = Buffer.from('not an image', 'utf8');

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('persistSessionMediaItem', () => {
  it('keeps canonical workspace-relative references across a symlink-aliased workspace root', async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-reference-alias-'));
    try {
      const realWorkspace = join(parentDirectory, 'real-workspace');
      const aliasedWorkspace = join(parentDirectory, 'workspace-alias');
      const outputPath = join(realWorkspace, 'generated.png');
      const referencePath = join(realWorkspace, 'references', 'source.png');
      await mkdir(join(realWorkspace, 'references'), { recursive: true });
      await writeFile(outputPath, pngBytes);
      await writeFile(referencePath, pngBytes);
      await symlink(realWorkspace, aliasedWorkspace);

      const result = await persistSessionMediaItem({
        workingDirectory: aliasedWorkspace,
        accessPolicy: { kind: 'restrictedRoots', roots: [aliasedWorkspace] },
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        input: {
          sessionId: 'session-reference-alias',
          messageLocalId: 'image-call-alias',
          role: 'output',
          category: 'generated',
          source: { kind: 'local-file', path: outputPath },
          origin: { source: 'provider-generated', agentId: 'cursor' },
          referenceImagePaths: [referencePath],
        },
      });

      expect(result).toMatchObject({
        success: true,
        item: {
          references: [{ path: 'references/source.png' }],
        },
      });
    } finally {
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  it('persists bounded description and only authorized regular reference-image metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-references-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-reference-outside-'));
    try {
      const outputPath = join(workingDirectory, 'generated.png');
      const referencePath = join(workingDirectory, 'references', 'source.png');
      const outsidePath = join(outsideDirectory, 'outside.png');
      const symlinkPath = join(workingDirectory, 'references', 'escape.png');
      await mkdir(join(workingDirectory, 'references'), { recursive: true });
      await writeFile(outputPath, pngBytes);
      await writeFile(referencePath, pngBytes);
      await writeFile(outsidePath, pngBytes);
      await symlink(outsidePath, symlinkPath);

      const result = await persistSessionMediaItem({
        workingDirectory,
        accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        input: {
          sessionId: 'session-references',
          messageLocalId: 'image-call-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'local-file', path: outputPath },
          origin: { source: 'provider-generated', agentId: 'cursor', toolCallId: 'image-call-1' },
          description: 'Architecture diagram\u0000 with control text',
          referenceImagePaths: [
            referencePath,
            outsidePath,
            symlinkPath,
            join(workingDirectory, 'references'),
            'https://example.com/reference.png',
          ],
        },
      });

      if (!result.success) throw new Error(`${result.code}: ${result.error}`);

      expect(result).toMatchObject({
        success: true,
        item: {
          description: 'Architecture diagram with control text',
          references: [{
            mediaKind: 'image',
            path: 'references/source.png',
            mimeType: 'image/png',
            sizeBytes: pngBytes.byteLength,
          }],
        },
      });
      expect(JSON.stringify(result)).not.toContain(outsideDirectory);
      expect(JSON.stringify(result)).not.toContain('https://');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed for outside, traversal, symlink, missing, directory, and oversized local output sources', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-policy-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-policy-outside-'));
    try {
      const insideDirectory = join(workingDirectory, 'generated');
      const outsidePath = join(outsideDirectory, 'outside.png');
      const symlinkPath = join(insideDirectory, 'escape.png');
      const oversizedPath = join(insideDirectory, 'oversized.png');
      await mkdir(insideDirectory, { recursive: true });
      await writeFile(outsidePath, pngBytes);
      await writeFile(oversizedPath, pngBytes);
      await symlink(outsidePath, symlinkPath);
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry();
      const accessPolicy = { kind: 'restrictedRoots' as const, roots: [workingDirectory] };
      const persistPath = (path: string, maxBytes = pngBytes.byteLength) => persistSessionMediaItem({
        workingDirectory,
        accessPolicy,
        pathAllowanceRegistry,
        maxBytes,
        input: {
          sessionId: 'session-policy',
          messageLocalId: 'image-call-policy',
          role: 'output' as const,
          category: 'generated' as const,
          source: { kind: 'local-file' as const, path },
          origin: { source: 'provider-generated' as const, agentId: 'cursor' },
        },
      });

      await expect(persistPath(outsidePath)).resolves.toMatchObject({ success: false, code: 'unauthorized_source_path' });
      await expect(persistPath(join(workingDirectory, '..', outsideDirectory.split('/').pop()!, 'outside.png')))
        .resolves.toMatchObject({ success: false, code: 'unauthorized_source_path' });
      await expect(persistPath(symlinkPath)).resolves.toMatchObject({ success: false, code: 'unauthorized_source_path' });
      await expect(persistPath(join(insideDirectory, 'missing.png')))
        .resolves.toMatchObject({ success: false, code: 'invalid_source_file' });
      await expect(persistPath(insideDirectory)).resolves.toMatchObject({ success: false, code: 'invalid_source_file' });
      await expect(persistPath(oversizedPath, pngBytes.byteLength - 1))
        .resolves.toMatchObject({ success: false, code: 'media_too_large' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('persists base64 generated image bytes as workspace-local session media metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-base64-'));
    const readAllowedDirs: { current: readonly string[] } = { current: [] };
    const writeAllowedDirs: { current: readonly string[] } = { current: [] };

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'info', 'exclude'), '# existing\n', 'utf8');
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = dirs;
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = dirs;
        },
      });

      const result = await persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry,
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-1',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
            suggestedName: '../Generated Image?.png',
          },
          origin: { source: 'provider-generated' },
          createdAtMs: 123,
        },
      });

      expect(result).toMatchObject({
        success: true,
        item: {
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          mimeType: 'image/png',
          sizeBytes: pngBytes.byteLength,
          sha256: sha256Hex(pngBytes),
          width: 1,
          height: 1,
          createdAtMs: 123,
          origin: { source: 'provider-generated' },
        },
      });
      if (!result?.success) throw new Error('expected persistence to succeed');
      expect(result.item.name).toBe('Generated Image_.png');
      expect(result.item.path).toMatch(/^\.happier\/uploads\/generated\/message-1\/[0-9a-f-]+-Generated Image_\.png$/);
      expect(isAbsolute(result.item.path)).toBe(false);
      expect(result.item.path).not.toContain('file://');
      expect(JSON.stringify(result.item)).not.toContain(pngBytes.toString('base64'));
      await expect(readFile(resolve(workingDirectory, result.item.path))).resolves.toEqual(pngBytes);
      await expect(readFile(join(workingDirectory, '.git', 'info', 'exclude'), 'utf8')).resolves.toContain('/.happier/uploads/');
      expect(readAllowedDirs.current).toEqual([]);
      expect(writeAllowedDirs.current).toEqual([]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('adopts local provider files into artifact storage and sniffs MIME from bytes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-file-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-provider-media-'));

    try {
      const sourcePath = join(providerDirectory, 'misleading.png');
      await writeFile(sourcePath, gifBytes);
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

      const result = await persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry,
        maxBytes: gifBytes.byteLength,
        input: {
          sessionId: 'session-2',
          messageLocalId: 'tool-call-1',
          role: 'output',
          category: 'tool-artifact',
          source: {
            kind: 'local-file',
            path: sourcePath,
            mimeType: 'image/png',
            suggestedName: 'chart.png',
          },
          origin: { source: 'tool-output' },
        },
      });

      expect(result).toMatchObject({
        success: true,
        item: {
          category: 'tool-artifact',
          mimeType: 'image/gif',
          sizeBytes: gifBytes.byteLength,
          sha256: sha256Hex(gifBytes),
        },
      });
      if (!result?.success) throw new Error('expected persistence to succeed');
      expect(result.item.path).toMatch(/^\.happier\/uploads\/artifacts\/tool-call-1\/[0-9a-f-]+-chart\.gif$/);
      expect(result.item.path).not.toContain(sourcePath);
      await expect(readFile(resolve(workingDirectory, result.item.path))).resolves.toEqual(gifBytes);
      await expect(readFile(sourcePath)).resolves.toEqual(gifBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });

  it('persists authorized file URIs without storing file URI metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-uri-'));
    const sourcePath = join(workingDirectory, 'source image.png');

    try {
      await writeFile(sourcePath, pngBytes);
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

      const result = await persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry,
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-3',
          messageLocalId: 'message-uri',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'local-uri',
            uri: new URL(`file://${sourcePath}`).toString(),
            mimeType: 'image/png',
          },
          origin: { source: 'local-file' },
          suggestedName: 'uri-image.png',
        },
      });

      expect(result).toMatchObject({ success: true, item: { mimeType: 'image/png' } });
      if (!result?.success) throw new Error('expected persistence to succeed');
      expect(JSON.stringify(result.item)).not.toContain('file://');
      await expect(stat(resolve(workingDirectory, result.item.path))).resolves.toMatchObject({ size: pngBytes.byteLength });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('strips non-contract origin fields from persisted metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-origin-'));
    const providerTempPath = join(tmpdir(), 'provider-temp', 'image.png');
    const originWithRuntimeFields: SessionMediaOrigin & {
      backendId: string;
      providerTempPath: string;
      providerUrl: string;
    } = {
      source: 'provider-generated',
      agentId: 'codex',
      generationId: 'generation-1',
      backendId: 'codex-app-server',
      providerTempPath,
      providerUrl: 'file:///tmp/provider-temp/image.png',
    };

    try {
      const result = await persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-origin',
          messageLocalId: 'message-origin',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
          },
          origin: originWithRuntimeFields,
        },
      });

      expect(result).toMatchObject({
        success: true,
        item: {
          origin: {
            source: 'provider-generated',
            agentId: 'codex',
            generationId: 'generation-1',
          },
        },
      });
      if (!result?.success) throw new Error('expected persistence to succeed');
      const serialized = JSON.stringify(result.item);
      expect(serialized).not.toContain('backendId');
      expect(serialized).not.toContain(providerTempPath);
      expect(serialized).not.toContain('file://');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('bounds provider correlation identifiers before returning durable metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-origin-bounds-'));
    try {
      const result = await persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-origin-bounds',
          messageLocalId: 'message-origin-bounds',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
          },
          origin: {
            source: 'provider-generated',
            agentId: `cursor-${'a'.repeat(17_000)}`,
            toolCallId: `call-${'b'.repeat(17_000)}`,
          },
        },
      });

      expect(result).toMatchObject({ success: true });
      if (!result.success) throw new Error(result.error);
      expect(result.item.origin.agentId).toHaveLength(16_384);
      expect(result.item.origin.toolCallId).toHaveLength(16_384);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects unsupported MIME and oversize media before writing metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-reject-'));

    try {
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

      await expect(persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry,
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-4',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: Buffer.from('plain text').toString('base64'), mimeType: 'text/plain' },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'unsupported_mime' });

      await expect(persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry,
        maxBytes: pngBytes.byteLength - 1,
        input: {
          sessionId: 'session-4',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'media_too_large' });

      await expect(persistSessionMediaItem({
        workingDirectory,
        accessPolicy: { kind: 'restrictedRoots', roots: [join(workingDirectory, 'allowed')] },
        pathAllowanceRegistry,
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-4',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'unauthorized_media_path' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects base64 bytes that do not sniff as an image even when declared as image/png', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-invalid-base64-image-'));

    try {
      await expect(persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: nonImageBytes.byteLength,
        input: {
          sessionId: 'session-invalid-base64',
          messageLocalId: 'message-invalid-base64',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'base64',
            data: nonImageBytes.toString('base64'),
            mimeType: 'image/png',
            suggestedName: 'declared.png',
          },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'unsupported_mime' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects local-file bytes that do not sniff as an image even when declared as image/png', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-invalid-file-image-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-provider-invalid-media-'));

    try {
      const sourcePath = join(providerDirectory, 'declared.png');
      await writeFile(sourcePath, nonImageBytes);

      await expect(persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: nonImageBytes.byteLength,
        input: {
          sessionId: 'session-invalid-file',
          messageLocalId: 'message-invalid-file',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'local-file',
            path: sourcePath,
            mimeType: 'image/png',
            suggestedName: 'declared.png',
          },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'unsupported_mime' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });

  it('rejects unsafe path inputs and provider-file placeholders without durable bytes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-unsafe-'));

    try {
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

      await expect(persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry,
        input: {
          sessionId: 'session-5',
          messageLocalId: '../escape',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'invalid_message_local_id' });

      await expect(persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry,
        input: {
          sessionId: 'session-5',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'local-uri', uri: 'https://example.com/image.png', mimeType: 'image/png' },
          origin: { source: 'local-file' },
        },
      })).resolves.toMatchObject({ success: false, code: 'unsupported_uri' });

      await expect(persistSessionMediaItem({
        workingDirectory,
        pathAllowanceRegistry,
        input: {
          sessionId: 'session-5',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'provider-file', providerFileId: 'file-123', mimeType: 'image/png' },
          origin: { source: 'provider-generated', providerFileId: 'file-123' },
        },
      })).resolves.toMatchObject({ success: false, code: 'provider_file_unavailable' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
