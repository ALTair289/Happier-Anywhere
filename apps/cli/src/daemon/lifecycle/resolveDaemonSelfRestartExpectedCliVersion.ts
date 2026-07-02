import type { readFileSync } from 'node:fs';

import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { projectPath } from '@/projectPath';

export function resolveDaemonSelfRestartExpectedCliVersion(options: Readonly<{
  currentCliVersion: string;
  projectRootPath?: string;
  readFileSyncImpl?: typeof readFileSync;
}>): string {
  return resolveComparableCliVersion({
    fallbackVersion: options.currentCliVersion,
    projectRootPath: options.projectRootPath ?? projectPath(),
    readFileSyncImpl: options.readFileSyncImpl,
  });
}
