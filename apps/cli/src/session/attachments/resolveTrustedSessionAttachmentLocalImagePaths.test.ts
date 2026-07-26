import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readTrustedSessionAttachmentLocalImages } from './resolveTrustedSessionAttachmentLocalImagePaths';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(),
    stat: vi.fn(),
  };
});

describe('readTrustedSessionAttachmentLocalImages', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(stat).mockReset();
  });

  it('rejects bytes whose read length differs from the declared and statted upload size', async () => {
    const declaredSizeBytes = 4;
    const replacementBytes = Buffer.from([1, 2, 3]);
    const uploadPath = '.happier/uploads/messages/message-1/screen.png';
    vi.mocked(stat).mockResolvedValue({
      isFile: () => true,
      size: declaredSizeBytes,
    } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue(replacementBytes);

    const trusted = await readTrustedSessionAttachmentLocalImages({
      cwd: '/workspace',
      metadata: {
        happier: {
          kind: 'attachments.v1',
          payload: {
            attachments: [{
              path: uploadPath,
              mimeType: 'image/png',
              sizeBytes: declaredSizeBytes,
              sha256: createHash('sha256').update(replacementBytes).digest('hex'),
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

    expect(trusted).toEqual(new Map());
  });
});
