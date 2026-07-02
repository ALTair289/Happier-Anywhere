import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
  configuration: {},
}));

import { resolveExistingSessionAttachContext } from './resolveExistingSessionAttachContext';

describe('resolveExistingSessionAttachContext import behavior', () => {
  it('does not create the existing-session lookup gate at module import time', async () => {
    expect(resolveExistingSessionAttachContext).toEqual(expect.any(Function));
  });
});
