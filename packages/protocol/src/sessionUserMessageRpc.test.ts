import { describe, expect, it } from 'vitest';

import {
  readAttachmentEnvelopeLocalImagePaths,
  sanitizeSessionUserMessageSendMeta,
  SessionUserMessageSendRequestSchema,
  SessionUserMessageSendResponseSchema,
} from './sessionUserMessageRpc.js';

describe('SessionUserMessageSendResponseSchema', () => {
  it('accepts successful ACK payloads', () => {
    expect(SessionUserMessageSendResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('accepts provider-acceptance pending custody on successful ACK payloads', () => {
    expect(SessionUserMessageSendResponseSchema.parse({
      ok: true,
      providerAcceptancePending: true,
    })).toEqual({
      ok: true,
      providerAcceptancePending: true,
    });
  });

  it('accepts runtime error ACK payloads', () => {
    expect(
      SessionUserMessageSendResponseSchema.parse({
        ok: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      }),
    ).toEqual({
      ok: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
  });
});

describe('SessionUserMessageSendRequestSchema', () => {
  it('drops untrusted structured local image attachment paths from RPC metadata', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            attachments: [
              {
                type: 'localImage',
                kind: 'image',
                localPath: '/etc/passwd',
                path: '/tmp/private.png',
                mimeType: 'image/png',
              },
            ],
          },
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
        },
      },
    });
  });

  it('drops untrusted final structured local image input paths from RPC metadata', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            imageInputs: [
              {
                type: 'localImage',
                kind: 'image',
                localPath: '/etc/passwd',
                path: '/tmp/private.png',
                mimeType: 'image/png',
              },
            ],
          },
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
        },
      },
    });
  });

  it('does not preserve raw structured input when one envelope field is malformed', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            vendorPluginMentions: 'not-an-array',
            attachments: [
              {
                type: 'localImage',
                kind: 'image',
                localPath: '/etc/passwd',
                mimeType: 'image/png',
              },
            ],
          },
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
        },
      },
    });
  });

  it('drops malformed structured input envelopes from RPC metadata', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: 'not-an-envelope',
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {},
    });
  });

  it('drops forged local image provenance for paths outside session attachment uploads', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            attachments: [
              {
                type: 'localImage',
                kind: 'image',
                localPath: '/Users/alice/private/screenshot.png',
                mimeType: 'image/png',
                provenance: { kind: 'sessionAttachmentUpload' },
              },
            ],
          },
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
        },
      },
    });
  });

  it('drops forged local image provenance for upload-shaped paths without matching attachment metadata', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            attachments: [
              {
                type: 'localImage',
                kind: 'image',
                localPath: '.happier/uploads/messages/m1/secret.png',
                mimeType: 'image/png',
                provenance: { kind: 'sessionAttachmentUpload' },
              },
            ],
          },
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
        },
      },
    });
  });

  it('drops local image metadata even when caller supplies matching attachment metadata without a trusted allowance', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happier: {
            kind: 'attachments.v1',
            payload: {
              attachments: [
                {
                  name: 'screen.png',
                  path: '.happier/uploads/messages/m1/screen.png',
                  mimeType: 'image/png',
                  sizeBytes: 42,
                },
              ],
            },
          },
          happierStructuredInputV1: {
            v: 1,
            attachments: [
              {
                type: 'localImage',
                kind: 'image',
                localPath: '.happier/uploads/messages/m1/screen.png',
                mimeType: 'image/png',
                provenance: { kind: 'sessionAttachmentUpload' },
              },
            ],
          },
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {
        happier: {
          kind: 'attachments.v1',
          payload: {
            attachments: [
              {
                name: 'screen.png',
                path: '.happier/uploads/messages/m1/screen.png',
                mimeType: 'image/png',
                sizeBytes: 42,
              },
            ],
          },
        },
        happierStructuredInputV1: {
          v: 1,
        },
      },
    });
  });

  it('preserves uploaded local image metadata when the caller supplies a trusted attachment allowlist', () => {
    const meta = {
      happier: {
        kind: 'attachments.v1',
        payload: {
          attachments: [
            {
              name: 'screen.png',
              path: '.happier/uploads/messages/m1/screen.png',
              mimeType: 'image/png',
              sizeBytes: 42,
            },
          ],
        },
      },
      happierStructuredInputV1: {
        v: 1,
        attachments: [
          {
            type: 'localImage',
            kind: 'image',
            localPath: '.happier/uploads/messages/m1/screen.png',
            mimeType: 'image/png',
            provenance: { kind: 'sessionAttachmentUpload' },
          },
        ],
      },
    };

    expect(readAttachmentEnvelopeLocalImagePaths(meta)).toEqual(new Set(['.happier/uploads/messages/m1/screen.png']));
    expect(sanitizeSessionUserMessageSendMeta(meta, {
      allowedLocalImagePaths: new Set(['.happier/uploads/messages/m1/screen.png']),
    })).toMatchObject({
      happierStructuredInputV1: {
        v: 1,
        attachments: [
          {
            type: 'localImage',
            localPath: '.happier/uploads/messages/m1/screen.png',
            path: '.happier/uploads/messages/m1/screen.png',
            provenance: { kind: 'sessionAttachmentUpload' },
          },
        ],
      },
    });
  });

  it('preserves final structured image inputs when the caller supplies a trusted attachment allowlist', () => {
    const meta = {
      happier: {
        kind: 'attachments.v1',
        payload: {
          attachments: [
            {
              name: 'screen.png',
              path: '.happier/uploads/messages/m1/screen.png',
              mimeType: 'image/png',
              sizeBytes: 42,
            },
          ],
        },
      },
      happierStructuredInputV1: {
        v: 1,
        imageInputs: [
          {
            type: 'localImage',
            kind: 'image',
            localPath: '.happier/uploads/messages/m1/screen.png',
            mimeType: 'image/png',
            provenance: { kind: 'sessionAttachmentUpload' },
          },
          {
            type: 'image',
            kind: 'image',
            url: 'https://example.test/screen.png',
            mimeType: 'image/png',
          },
        ],
      },
    };

    expect(sanitizeSessionUserMessageSendMeta(meta, {
      allowedLocalImagePaths: new Set(['.happier/uploads/messages/m1/screen.png']),
    })).toMatchObject({
      happierStructuredInputV1: {
        v: 1,
        imageInputs: [
          {
            type: 'localImage',
            localPath: '.happier/uploads/messages/m1/screen.png',
            path: '.happier/uploads/messages/m1/screen.png',
            provenance: { kind: 'sessionAttachmentUpload' },
          },
          {
            type: 'image',
            url: 'https://example.test/screen.png',
          },
        ],
      },
    });
  });
});
