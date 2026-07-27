import { join } from 'node:path';

import {
  RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryIntent,
  type RuntimeAuthRecoverySchedulerDeps,
} from './RuntimeAuthRecoveryScheduler';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';

export function createRuntimeAuthRecoverySchedulerForDaemon(input: Readonly<{
  activeServerDir: string;
}> & Omit<RuntimeAuthRecoverySchedulerDeps, 'durableStore'>): Readonly<{
  scheduler: RuntimeAuthRecoveryScheduler;
  hydratedIntents: ReadonlyArray<RuntimeAuthRecoveryIntent>;
}> {
  const { activeServerDir, ...schedulerDeps } = input;
  const scheduler = new RuntimeAuthRecoveryScheduler({
    ...schedulerDeps,
    durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(join(
      activeServerDir,
      'connected-services',
      'runtime-auth-recovery.json',
    )),
  });
  return {
    scheduler,
    hydratedIntents: scheduler.hydratePassive(),
  };
}
