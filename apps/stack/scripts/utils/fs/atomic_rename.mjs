import { rename } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const WINDOWS_TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

export async function renameForPublication(
  from,
  to,
  {
    platform = process.platform,
    renameImpl = rename,
    waitImpl = wait,
    maxRetries = 8,
  } = {},
) {
  let retry = 0;
  while (true) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (
        platform !== 'win32'
        || !WINDOWS_TRANSIENT_RENAME_CODES.has(error?.code)
        || retry >= maxRetries
      ) {
        throw error;
      }
      await waitImpl(Math.min(25 * (2 ** retry), 400));
      retry += 1;
    }
  }
}
