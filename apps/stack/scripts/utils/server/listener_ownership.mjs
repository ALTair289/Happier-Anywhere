import { listListenPids } from '../net/ports.mjs';
import { getProcessGroupId, isPidOwnedByStack } from '../proc/ownership.mjs';

export async function resolveStackOwnedListenPid(
  { port, stackName, envPath },
  {
    listListenPidsImpl = listListenPids,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    getProcessGroupIdImpl = getProcessGroupId,
  } = {},
) {
  const serverPort = Number(port);
  if (!Number.isFinite(serverPort) || serverPort <= 0) return null;

  const listenPids = await listListenPidsImpl(serverPort, { timeoutMs: 1000 }).catch(() => []);
  if (!listenPids.length) return null;

  let expectedPgid = null;
  for (const pid of listenPids) {
    // eslint-disable-next-line no-await-in-loop
    const owned = await isPidOwnedByStackImpl(pid, { stackName, envPath }).catch(() => false);
    if (!owned) {
      return null;
    }

    // eslint-disable-next-line no-await-in-loop
    const pgid = await getProcessGroupIdImpl(pid).catch(() => null);
    if (!pgid) {
      if (listenPids.length > 1) {
        return null;
      }
      continue;
    }
    if (!expectedPgid) {
      expectedPgid = pgid;
    } else if (pgid !== expectedPgid) {
      return null;
    }
  }

  return listenPids[0] ?? null;
}
