import path from 'node:path';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

/**
 * Canonicalize the attach `--dir` so it matches the directory the OpenCode server associates with
 * the session. OpenCode's attached-TUI applies a client-side directory drop-filter on incoming
 * events (`cli/cmd/tui/context/event.ts`): events whose directory does not match the TUI's `--dir`
 * are silently dropped. Trailing separators, `.`/`..` segments, mixed separators, or `~`-relative
 * inputs would all defeat that match, so normalize to a canonical absolute path here (Lane H / S3).
 *
 * Platform-aware: Windows-shaped inputs (`C:\...`, UNC) are normalized with the win32 path API and
 * POSIX inputs with the posix API regardless of the host platform, so cross-platform values are not
 * mangled (e.g. a `C:\repo` attach target stays intact when produced/tested on a POSIX host). A
 * non-absolute value is left untouched rather than being resolved against an unrelated cwd.
 *
 * Residual upstream-TUI limits NOT fixable from Happier: the TUI's one-shot initial sync guard and
 * the lack of catch-up after an SSE gap, plus any symlink/realpath divergence between the directory
 * passed here and the realpath the server stored. Those are documented as upstream constraints.
 */
function canonicalizeAttachDirectory(directory: string): string {
  const trimmed = typeof directory === 'string' ? directory.trim() : '';
  if (!trimmed) return directory;
  const expanded = expandHomeDirPath(trimmed);
  const isWindowsShaped = /^[a-zA-Z]:[\\/]/u.test(expanded) || expanded.startsWith('\\\\');
  const api = isWindowsShaped ? path.win32 : path.posix;
  if (!api.isAbsolute(expanded)) return expanded;
  const normalized = api.normalize(expanded);
  // Strip trailing separators while preserving a bare root (e.g. '/').
  const stripped = normalized.replace(/[\\/]+$/u, '');
  return stripped.length > 0 ? stripped : normalized;
}

export function createOpenCodeAttachArgs(params: Readonly<{
  baseUrl: string;
  directory: string;
  sessionId: string;
}>): string[] {
  return [
    'attach',
    params.baseUrl,
    '--dir',
    canonicalizeAttachDirectory(params.directory),
    '--session',
    params.sessionId,
  ];
}
