import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

function resolveKeepCount(keepCount) {
  if (!Number.isFinite(keepCount)) return 0;
  return Math.max(0, Math.floor(keepCount));
}

function sortNewestFirst(a, b) {
  return a < b ? 1 : a > b ? -1 : 0;
}

export async function pruneLogsByCount({
  dir,
  prefix,
  suffix,
  keepCount,
  keepPath,
}) {
  try {
    const resolvedKeepCount = resolveKeepCount(keepCount);
    const keepName = keepPath ? basename(keepPath) : null;
    const resolvedPrefix = typeof prefix === 'string' ? prefix : null;
    const entries = (await readdir(dir))
      .filter((entry) => {
        if (resolvedPrefix !== null && !entry.startsWith(resolvedPrefix)) return false;
        return entry.endsWith(suffix);
      })
      .sort(sortNewestFirst);

    const keep = new Set(entries.slice(0, resolvedKeepCount));
    if (keepName !== null) keep.add(keepName);

    let pruned = 0;
    for (const entry of entries) {
      if (keep.has(entry)) continue;
      try {
        await rm(join(dir, entry), { force: true });
        pruned += 1;
      } catch {
        // Best-effort pruning only.
      }
    }

    return { pruned };
  } catch {
    return { pruned: 0 };
  }
}
