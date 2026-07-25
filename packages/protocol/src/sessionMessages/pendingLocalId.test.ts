import { describe, expect, it } from 'vitest';

import {
  PendingLocalIdSchema,
  readPendingLocalId,
} from './pendingLocalId.js';

describe('Pending localId', () => {
  it.each([undefined, null, '', ' ', '\t\r\n'])('rejects a blank identity without substituting one: %j', (value) => {
    expect(readPendingLocalId(value)).toBeNull();
    expect(PendingLocalIdSchema.safeParse(value).success).toBe(false);
  });

  it('preserves every accepted code unit', () => {
    const localId = ' \tOpaque-Pending-ID\u00a0 ';

    expect(readPendingLocalId(localId)).toBe(localId);
    expect(PendingLocalIdSchema.parse(localId)).toBe(localId);
  });
});
