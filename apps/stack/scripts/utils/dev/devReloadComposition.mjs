import {
  createHappyCliReloadDescriptors,
  createHappyCliReloadExecutor,
} from './daemon.mjs';
import {
  createDevServerReloadDescriptors,
  createDevServerReloadExecutor,
} from './server.mjs';
import { startDevReloadCoordinator } from './devReloadCoordinator.mjs';

export function startDevReloadComposition({
  watchEnabled,
  daemonReloadEnabled,
  daemonOptions,
  serverReloadEnabled,
  serverOptions,
  debounceMs = 500,
  pollIntervalMs = 0,
  isShuttingDown,
  logger = console,
} = {}, {
  createHappyCliReloadDescriptorsImpl = createHappyCliReloadDescriptors,
  createHappyCliReloadExecutorImpl = createHappyCliReloadExecutor,
  createDevServerReloadDescriptorsImpl = createDevServerReloadDescriptors,
  createDevServerReloadExecutorImpl = createDevServerReloadExecutor,
  startDevReloadCoordinatorImpl = startDevReloadCoordinator,
} = {}) {
  const descriptors = [];
  const executors = [];

  if (daemonReloadEnabled) {
    descriptors.push(...createHappyCliReloadDescriptorsImpl({ cliDir: daemonOptions.cliDir }));
    executors.push(createHappyCliReloadExecutorImpl(daemonOptions));
  }

  if (serverReloadEnabled) {
    descriptors.push(...createDevServerReloadDescriptorsImpl({ serverDir: serverOptions.serverDir }));
    executors.push(createDevServerReloadExecutorImpl(serverOptions));
  }

  return startDevReloadCoordinatorImpl({
    enabled: watchEnabled,
    descriptors,
    executors,
    debounceMs,
    pollIntervalMs,
    isShuttingDown,
    logger,
  });
}
