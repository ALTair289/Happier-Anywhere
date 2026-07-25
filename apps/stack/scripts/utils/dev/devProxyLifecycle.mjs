import { recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';

export function createDevProxyUnexpectedExitHandler({
  stackMode,
  runtimeStatePath,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  requestShutdownImpl,
  logger = console,
} = {}) {
  return async ({ code = null, signal = null } = {}) => {
    if (stackMode && runtimeStatePath) {
      await recordStackRuntimeUpdateImpl(runtimeStatePath, {
        processes: { proxyPid: null },
        serverProxy: {
          enabled: false,
          mode: 'unavailable',
          restartMode: null,
          fallbackReason: `proxy child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        },
      }).catch((error) => {
        logger.error?.(`[local] failed to reconcile proxy runtime state: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    logger.error?.('[local] server proxy exited unexpectedly; shutting down stack lifecycle owner.');
    requestShutdownImpl?.('server_proxy_unavailable');
  };
}
