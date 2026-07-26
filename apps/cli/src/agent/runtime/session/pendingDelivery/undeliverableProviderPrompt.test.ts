import { describe, expect, it, vi } from 'vitest';

import {
  blockUndeliverableProviderPrompt,
  normalizePendingDeliveryLocalIds,
  readSinglePendingDeliveryLocalId,
} from './undeliverableProviderPrompt';

describe('normalizePendingDeliveryLocalIds', () => {
  it('preserves exact nonblank local-id bytes, rejects whitespace-only values, and deduplicates exact identities only', () => {
    expect(normalizePendingDeliveryLocalIds([
      ' local-1\n',
      'local-1',
      ' local-1\n',
      '   ',
      '',
    ])).toEqual([
      ' local-1\n',
      'local-1',
    ]);
  });
});

describe('readSinglePendingDeliveryLocalId', () => {
  it('preserves one exact nonempty opaque identity', () => {
    expect(readSinglePendingDeliveryLocalId([' local-1\n'])).toBe(' local-1\n');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', []],
    ['empty string', ['']],
    ['whitespace-only string', ['   ']],
    ['plural', ['pending-local-a', 'pending-local-b']],
    ['duplicate plural', ['pending-local-a', 'pending-local-a']],
  ] as const)('rejects %s attribution before provider dispatch', (_label, localIds) => {
    expect(readSinglePendingDeliveryLocalId(localIds)).toBeNull();
  });
});

describe('blockUndeliverableProviderPrompt', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', []],
    ['empty string', ['']],
    ['plural', ['pending-local-a', 'pending-local-b']],
  ] as const)('fails closed for %s canonical Pending identity', (_label, localIds) => {
    const blockPendingMessageDelivery = vi.fn(async () => true);

    blockUndeliverableProviderPrompt({
      localIds,
      blockPendingMessageDelivery,
      blockReason: 'provider_rejected_before_acceptance',
      logPrefix: '[test]',
    });

    expect(blockPendingMessageDelivery).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only Pending identity before any server mutation', () => {
    const blockPendingMessageDelivery = vi.fn(async () => true);

    blockUndeliverableProviderPrompt({
      localIds: ['   '],
      blockPendingMessageDelivery,
      blockReason: 'provider_rejected_before_acceptance',
      logPrefix: '[test]',
    });

    expect(blockPendingMessageDelivery).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'not-owned', 'error'] as const)(
    'does not replay exact Pending input when server blocking is %s',
    async (outcome) => {
      const blockPendingMessageDelivery = outcome === 'unavailable'
        ? undefined
        : vi.fn(async () => {
            if (outcome === 'error') throw new Error('transport failed');
            return false;
          });

      blockUndeliverableProviderPrompt({
        localIds: ['pending-local-id'],
        blockPendingMessageDelivery,
        blockReason: 'provider_rejected_before_acceptance',
        logPrefix: '[test]',
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (blockPendingMessageDelivery) {
        expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
          localIds: ['pending-local-id'],
          reason: 'provider_rejected_before_acceptance',
        });
      }
    },
  );
});
