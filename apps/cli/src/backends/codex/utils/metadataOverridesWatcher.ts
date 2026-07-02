import { waitForSessionMetadataRetryBackoff } from '@/agent/runtime/sessionMetadataWaitRetryBackoff';

export async function runMetadataOverridesWatcherLoop(args: Readonly<{
  shouldExit: () => boolean;
  getAbortSignal: () => AbortSignal | undefined;
  waitForMetadataUpdate: (signal?: AbortSignal) => Promise<boolean>;
  onUpdate: () => void | Promise<void>;
  abortedBackoffMs?: number;
}>): Promise<void> {
  while (!args.shouldExit()) {
    const signal = args.getAbortSignal();
    const backoff = () => waitForSessionMetadataRetryBackoff({
      backoffMs: args.abortedBackoffMs,
      defaultMs: 25,
      minMs: 1,
    });
    let didUpdate = false;
    try {
      didUpdate = await args.waitForMetadataUpdate(signal);
    } catch {
      await backoff();
      continue;
    }
    if (!didUpdate) {
      // Avoid a hot loop when waitForMetadataUpdate resolves immediately for detached, disconnected, or aborted clients.
      if (args.shouldExit()) {
        break;
      }
      await backoff();
      continue;
    }
    try {
      await args.onUpdate();
    } catch {
      await backoff();
    }
  }
}
