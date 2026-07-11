import { constants } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { copyFileMock, linkMock } = vi.hoisted(() => ({
  copyFileMock: vi.fn(),
  linkMock: vi.fn(),
}));

// The filesystem is the system boundary under test; internal media logic remains real.
vi.mock('node:fs/promises', () => ({
  copyFile: copyFileMock,
  link: linkMock,
}));

import { adoptSessionMediaSourceFile } from './adoptSessionMediaSourceFile';

describe('adoptSessionMediaSourceFile', () => {
  beforeEach(() => {
    copyFileMock.mockReset();
    linkMock.mockReset();
  });

  it('falls back to an independent byte copy when reflink cloning is unavailable', async () => {
    copyFileMock
      .mockRejectedValueOnce(Object.assign(new Error('clone unsupported'), { code: 'ENOTSUP' }))
      .mockResolvedValueOnce(undefined);

    await adoptSessionMediaSourceFile({
      sourcePath: '/provider/generated.png',
      destinationPath: '/workspace/.happier/uploads/generated/image.png',
    });

    expect(copyFileMock).toHaveBeenNthCalledWith(
      1,
      '/provider/generated.png',
      '/workspace/.happier/uploads/generated/image.png',
      constants.COPYFILE_FICLONE,
    );
    expect(copyFileMock).toHaveBeenNthCalledWith(
      2,
      '/provider/generated.png',
      '/workspace/.happier/uploads/generated/image.png',
    );
    expect(linkMock).not.toHaveBeenCalled();
  });
});
