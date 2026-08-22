import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type {
  SessionProviderInputConsumerOptions,
  SessionProviderInputConsumerSession,
} from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { MessageBatch, SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';

export async function waitForNextPermissionModeMessage<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  session: ApiSessionClient;
  inputConsumer?: SessionProviderInputConsumer<Mode, Message>;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
}): Promise<MessageBatch<Mode, Message> | null> {
  const waitForSessionInputUpdate = (signal?: AbortSignal): Promise<boolean> => {
    const metadataWait = typeof opts.session.waitForMetadataUpdate === 'function'
      ? opts.session.waitForMetadataUpdate(signal)
      : null;
    const pendingEligibilityWait = typeof opts.session.waitForPendingEligibilityUpdate === 'function'
      ? opts.session.waitForPendingEligibilityUpdate(signal)
      : null;

    if (metadataWait && pendingEligibilityWait) {
      return Promise.race([metadataWait, pendingEligibilityWait]);
    }
    return metadataWait ?? pendingEligibilityWait ?? Promise.resolve(false);
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
