import { describe, expect, it } from 'vitest';

import { LruSet } from '@/utils/collections/lru';

import { markUuidSeenAndReturnIsDuplicate } from './_shared';

describe('markUuidSeenAndReturnIsDuplicate', () => {
  it('keeps opaque Claude JSONL UUID aliases distinct by exact bytes', () => {
    const seenUuidsBySidechainId = new Map<string, LruSet>();
    const observe = (uuid: string) => markUuidSeenAndReturnIsDuplicate({
      seenUuidsBySidechainId,
      sidechainId: 'sidechain-1',
      uuid,
      maxSeenUuidsPerSidechain: 10,
    });

    expect(observe('uuid-1')).toBe(false);
    expect(observe(' uuid-1\n')).toBe(false);
    expect(observe('uuid-1')).toBe(true);
    expect(observe(' uuid-1\n')).toBe(true);
  });
});
