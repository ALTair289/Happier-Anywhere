import type { AgentBackend } from '@/agent/core';

export function wrapBackendDisposeWithCleanup<TBackend extends AgentBackend>(
  backend: TBackend,
  cleanup: () => void | Promise<void>,
): TBackend {
  let cleanedUp = false;

  return new Proxy(backend, {
    get(target, prop, receiver) {
      if (prop === 'dispose') {
        return async () => {
          try {
            await target.dispose();
          } finally {
            if (cleanedUp) return;
            cleanedUp = true;
            await cleanup();
          }
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TBackend;
}
