import { describe, expect, it, vi } from 'vitest';

import { fetchAllSessionSystemRecords } from './fetchAllSessionSystemRecords';

describe('fetchAllSessionSystemRecords', () => {
  it('collects every page in cursor order', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ records: [{ id: 'a' }], nextCursor: 'next', hasNext: true })
      .mockResolvedValueOnce({ records: [{ id: 'b' }], nextCursor: null, hasNext: false });

    await expect(fetchAllSessionSystemRecords({ fetchPage })).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'next');
  });

  it.each([
    ['missing', { records: [], nextCursor: null, hasNext: true }],
    ['cyclic', { records: [], nextCursor: 'same', hasNext: true }],
  ])('rejects %s continuation instead of returning a partial authority snapshot', async (_label, secondPage) => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ records: [{ id: 'a' }], nextCursor: secondPage.nextCursor ?? 'same', hasNext: true })
      .mockResolvedValueOnce(secondPage);

    await expect(fetchAllSessionSystemRecords({ fetchPage })).rejects.toThrow(/pagination/i);
  });
});
