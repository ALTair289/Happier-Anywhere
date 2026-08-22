import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type {
  SessionProviderInputConsumerOptions,
  SessionProviderInputConsumerSession,
} from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { MessageBatch, SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';

function waitForAnySuccessfulSessionInputUpdate(
  waits: readonly Promise<boolean>[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (waits.length === 0) return Promise.resolve(false);
  if (waits.length === 1) return waits[0]!;

  return new Promise<boolean>((resolve, reject) => {
    let completedWithoutUpdate = 0;
    let settled = false;
    const finish = (updated: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(updated);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => finish(false);

    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    for (const wait of waits) {
      void wait.then(
        (updated) => {
          if (updated) {
            finish(true);
            return;
          }
          completedWithoutUpdate += 1;
          if (completedWithoutUpdate === waits.length) finish(false);
        },
        fail,
      );
    }
  });
}

export async function waitForNextPermissionModeMessage<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  session: ApiSessionClient;
  inputConsumer?: SessionProviderInputConsumer<Mode, Message>;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
}): Promise<MessageBatch<Mode, Message> | null> {
  const waitForSessionInputUpdate = (signal?: AbortSignal): Promise<boolean> => {
    const waits: Promise<boolean>[] = [];
    const metadataWait = typeof opts.session.waitForMetadataUpdate === 'function'
      ? opts.session.waitForMetadataUpdate(signal)
      : null;
    const pendingEligibilityWait = typeof opts.session.waitForPendingEligibilityUpdate === 'function'
      ? opts.session.waitForPendingEligibilityUpdate(signal)
      : null;

    if (metadataWait) waits.push(metadataWait);
    if (pendingEligibilityWait) waits.push(pendingEligibilityWait);
    // `false` means only that one source ended without an update. Do not let it
    // suppress a later positive wake from the other independent source.
    return waitForAnySuccessfulSessionInputUpdate(waits, signal);
  };

  const session: SessionProviderInputConsumerSession = {
    materializeNextPendingMessageSafely: (materializeOpts) =>
      opts.session.materializeNextPendingMessageSafely(materializeOpts),
    shouldAttemptPendingMaterialization: () => opts.session.shouldAttemptPendingMaterialization?.() ?? true,
    reconcilePendingQueueState: async (reconcileOpts) => {
      await opts.session.reconcilePendingQueueState?.(reconcileOpts);
    },
    // Permission-mode changes are metadata updates, while Pending eligibility has
    // its own wake stream. The provider loop must observe both or it can sleep
    // forever after an in-session mode override.
    waitForPendingEligibilityUpdate: waitForSessionInputUpdate,
  };

  const consumerOptions: SessionProviderInputConsumerOptions<Mode, Message> = {
    messageQueue: opts.messageQueue,
    session,
    reconcileWhenEmpty: 'skip',
  };
  if (opts.onMetadataUpdate !== undefined) {
    consumerOptions.onMetadataUpdate = opts.onMetadataUpdate;
  }

  const inputConsumer = opts.inputConsumer ?? createSessionProviderInputConsumer(consumerOptions);

  return await inputConsumer.waitForNextInput({ abortSignal: opts.abortSignal });
}
