import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { buildAcpPromptContentBlocks } from './buildAcpPromptContentBlocks';

describe('buildAcpPromptContentBlocks', () => {
  it('projects text plus only hash-verified uploaded local images into binary-safe ACP blocks', async () => {
    await withTempDir('acp-prompt-image-', async (cwd) => {
      const bytes = Buffer.from([0, 255, 1, 2, 3, 128]);
      const uploadPath = '.happier/uploads/messages/message-1/screen.png';
      await mkdir(`${cwd}/.happier/uploads/messages/message-1`, { recursive: true });
      await writeFile(`${cwd}/${uploadPath}`, bytes);

      const blocks = await buildAcpPromptContentBlocks({
        cwd,
        text: 'inspect this',
        metadata: {
          happier: {
            kind: 'attachments.v1',
            payload: {
              attachments: [{
                path: uploadPath,
                mimeType: 'image/png',
                sizeBytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              }],
            },
          },
          happierStructuredInputV1: {
            v: 1,
            imageInputs: [{
              kind: 'image',
              path: uploadPath,
              mimeType: 'image/png',
              provenance: { kind: 'sessionAttachmentUpload' },
            }],
          },
        },
      });

      expect(blocks).toEqual([
        { type: 'text', text: 'inspect this' },
        { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
      ]);
    });
  });

  it('does not read an unverified or non-image attachment into an ACP prompt', async () => {
    await withTempDir('acp-prompt-untrusted-', async (cwd) => {
      await writeFile(`${cwd}/secret.png`, Buffer.from('secret'));
      await expect(buildAcpPromptContentBlocks({
        cwd,
        text: 'hello',
        metadata: {
          happierStructuredInputV1: {
            v: 1,
            imageInputs: [{
              kind: 'image',
              path: 'secret.png',
              mimeType: 'image/png',
              provenance: { kind: 'sessionAttachmentUpload' },
            }],
          },
        },
      })).resolves.toEqual([{ type: 'text', text: 'hello' }]);
    });
  });
});
