import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSessionMediaAccessPolicy } from './createSessionMediaAccessPolicy';
import { createAgentSessionMediaPersister } from './createAgentSessionMediaPersister';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

describe('createAgentSessionMediaPersister', () => {
  it('converts unexpected filesystem persistence failures into a non-fatal unavailable diagnostic', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-agent-session-media-io-failure-'));
    try {
      const sourcePath = join(workingDirectory, 'generated.png');
      await writeFile(sourcePath, pngBytes);
      await writeFile(join(workingDirectory, '.happier'), 'blocks the media directory', 'utf8');
      const diagnostics: unknown[] = [];
      const persister = createAgentSessionMediaPersister({
        workingDirectory,
        sessionId: 'session-io-failure',
        accessPolicy: createSessionMediaAccessPolicy({ workingDirectory }),
        onUnavailable: (diagnostic) => diagnostics.push(diagnostic),
      });

      await expect(persister.persist({
        type: 'session-media',
        source: 'cursor-generate-image',
        media: [{
          kind: 'local-file',
          path: sourcePath,
          origin: {
            source: 'provider-generated',
            agentId: 'cursor',
            toolCallId: 'image-call-io-failure',
          },
        }],
      })).resolves.toEqual([]);

      expect(diagnostics).toEqual([{
        code: 'persistence_failed',
        source: 'cursor-generate-image',
        agentId: 'cursor',
        toolCallIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }]);
      expect(JSON.stringify(diagnostics)).not.toContain(workingDirectory);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('reports a bounded unavailable diagnostic without exposing the rejected source path', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-agent-session-media-unavailable-'));
    try {
      const diagnostics: unknown[] = [];
      const persister = createAgentSessionMediaPersister({
        workingDirectory,
        sessionId: 'session-unavailable',
        accessPolicy: createSessionMediaAccessPolicy({ workingDirectory }),
        onUnavailable: (diagnostic) => diagnostics.push(diagnostic),
      });

      await expect(persister.persist({
        type: 'session-media',
        source: 'cursor-generate-image',
        media: [{
          kind: 'local-file',
          path: join(workingDirectory, 'missing-secret-name.png'),
          origin: {
            source: 'provider-generated',
            agentId: 'cursor',
            toolCallId: '/Users/alice/private/image-call-missing',
          },
        }],
      })).resolves.toEqual([]);

      expect(diagnostics).toEqual([{
        code: 'invalid_source_file',
        source: 'cursor-generate-image',
        agentId: 'cursor',
        toolCallIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }]);
      expect(JSON.stringify(diagnostics)).not.toContain('missing-secret-name.png');
      expect(JSON.stringify(diagnostics)).not.toContain('/Users/alice/private');
      expect(JSON.stringify(diagnostics).length).toBeLessThan(512);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('preserves bounded generated description and authorized reference metadata across the generic runtime seam', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-agent-session-media-'));
    try {
      const outputPath = join(workingDirectory, 'generated', 'output.png');
      const referencePath = join(workingDirectory, 'references', 'input.png');
      await mkdir(join(workingDirectory, 'generated'), { recursive: true });
      await mkdir(join(workingDirectory, 'references'), { recursive: true });
      await writeFile(outputPath, pngBytes);
      await writeFile(referencePath, pngBytes);

      const persister = createAgentSessionMediaPersister({
        workingDirectory,
        sessionId: 'session-1',
        accessPolicy: createSessionMediaAccessPolicy({ workingDirectory }),
      });
      const items = await persister.persist({
        type: 'session-media',
        source: 'cursor-generate-image',
        media: [{
          kind: 'local-file',
          path: outputPath,
          description: 'Generated architecture diagram',
          referenceImagePaths: [referencePath],
          origin: {
            source: 'provider-generated',
            agentId: 'cursor',
            toolCallId: 'image-call-1',
            generationId: 'image-call-1',
          },
        }],
      });

      expect(items).toMatchObject([{
        description: 'Generated architecture diagram',
        references: [{
          mediaKind: 'image',
          path: 'references/input.png',
          mimeType: 'image/png',
          sizeBytes: pngBytes.byteLength,
        }],
        origin: {
          source: 'provider-generated',
          agentId: 'cursor',
          toolCallId: 'image-call-1',
          generationId: 'image-call-1',
        },
      }]);
      expect(items[0]?.path).not.toContain('image-call-1');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
