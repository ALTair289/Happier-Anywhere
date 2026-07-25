const TEST_ONLY_DIRECTORY_NAMES = new Set([
  '__fixtures__',
  '__snapshots__',
  '__tests__',
  'coverage',
  'fixtures',
  'snapshots',
  'test',
  'testkit',
  'tests',
]);
const TEST_ONLY_FILE_RE = /(?:^|[._-])(?:test|spec|bench|benchmark)\.[cm]?[jt]sx?$/;
const TESTKIT_FILE_RE = /\.testkit\.[cm]?[jt]sx?$/;
const VITEST_SETUP_FILE_RE = /^vitestSetup\.[cm]?[jt]sx?$/;

export function isDevRuntimeReloadIgnoredPath(path) {
  const normalized = String(path ?? '').replaceAll('\\', '/');
  if (!normalized) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => TEST_ONLY_DIRECTORY_NAMES.has(part))) return true;
  const base = parts.at(-1) ?? '';
  return (
    TEST_ONLY_FILE_RE.test(base)
    || TESTKIT_FILE_RE.test(base)
    || VITEST_SETUP_FILE_RE.test(base)
    || base === 'vitest.config.ts'
    || base.startsWith('vitest.')
    || base.startsWith('test-setup.')
    || base.endsWith('.snap')
  );
}
