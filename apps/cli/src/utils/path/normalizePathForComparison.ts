import { realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { expandHomeDirPath } from './expandHomeDirPath';

type NormalizePathForComparisonOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>;

export function normalizePathForComparison(
  value: unknown,
  options: NormalizePathForComparisonOptions = {},
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const expanded = expandHomeDirPath(trimmed, env, platform);
  const usesWindowsPathRules =
    platform === 'win32'
    || /^[a-zA-Z]:[\\/]/u.test(expanded)
    || /^\\\\/u.test(expanded);
  const pathApi = usesWindowsPathRules ? win32 : posix;
  const normalized = pathApi.normalize(expanded).replaceAll('\\', '/');
  const withoutTrailingSeparators =
    normalized === '/'
    || /^[a-zA-Z]:\/$/u.test(normalized)
      ? normalized
      : normalized.replace(/\/+$/u, '');

  return usesWindowsPathRules ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}

export async function resolvePathForComparison(
  value: unknown,
  options: NormalizePathForComparisonOptions = {},
): Promise<string | null> {
  const lexical = normalizePathForComparison(value, options);
  if (lexical === null || typeof value !== 'string') return lexical;

  const platform = options.platform ?? process.platform;
  if (options.platform !== undefined && platform !== process.platform) return lexical;

  const env = options.env ?? process.env;
  const expanded = expandHomeDirPath(value.trim(), env, platform);
  try {
    return normalizePathForComparison(await realpath(expanded), options);
  } catch {
    return lexical;
  }
}
