import type { ExecutionRunState } from './executionRunTypes';
import type { SessionRuntimeActivityContribution } from '@/session/runtimeActivity/types';

export function deriveExecutionRunRuntimeActivityContribution(
  runs: ReadonlyMap<string, ExecutionRunState>,
): SessionRuntimeActivityContribution {
  let activeCount = 0;
  for (const run of runs.values()) {
    if (run.status === 'running') activeCount += 1;
  }
  return activeCount > 0
    ? { state: 'active', activeCount }
    : { state: 'idle', activeCount: 0 };
}
