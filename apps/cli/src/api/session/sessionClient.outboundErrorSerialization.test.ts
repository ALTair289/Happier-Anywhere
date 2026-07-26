import { describe, expect, it } from 'vitest';

import { serializeOutboundError } from './outboundErrorSerialization';

describe('serializeOutboundError', () => {
  it('preserves non-enumerable Error fields and a bounded cause chain', () => {
    const error = new Error('outer failure', {
      cause: new TypeError('inner failure', {
        cause: new RangeError('deep failure', {
          cause: new Error('must not escape the depth bound'),
        }),
      }),
    });

    const serialized = serializeOutboundError(error);

    expect(serialized).toMatchObject({
      name: 'Error',
      message: 'outer failure',
      stack: expect.any(String),
      cause: {
        name: 'TypeError',
        message: 'inner failure',
        cause: {
          name: 'RangeError',
          message: 'deep failure',
        },
      },
    });
    expect(serialized.cause?.cause).not.toHaveProperty('cause');
  });

  it('redacts authorization and URL credentials from messages, stacks, and causes', () => {
    const error = new Error(
      'Bearer TOP_SECRET https://alice:PASSWORD@example.test/path?token=secret',
      { cause: new Error('Authorization: Bearer NESTED_SECRET') },
    );

    const serializedText = JSON.stringify(serializeOutboundError(error));

    expect(serializedText).not.toContain('TOP_SECRET');
    expect(serializedText).not.toContain('PASSWORD');
    expect(serializedText).not.toContain('token=secret');
    expect(serializedText).not.toContain('NESTED_SECRET');
  });

  it('bounds unusually large messages and stacks', () => {
    const error = new Error(`failure:${'x'.repeat(32_000)}`);

    const serialized = serializeOutboundError(error);

    expect(Buffer.byteLength(serialized.message, 'utf8')).toBeLessThanOrEqual(4_200);
    expect(Buffer.byteLength(serialized.stack ?? '', 'utf8')).toBeLessThanOrEqual(4_200);
  });
});
