import { watch } from 'node:fs';

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeWatch(path, handler, watchImpl = watch, logger = console) {
  try {
    // Node supports recursive watching on macOS and Windows. On Linux this may throw; we fail closed by returning null.
    return watchImpl(path, { recursive: true }, handler);
  } catch {
    try {
      return watchImpl(path, {}, handler);
    } catch (error) {
      logger.warn?.(`[local] watch: unable to watch ${path}: ${formatError(error)}`);
      return null;
    }
  }
}

/**
 * Very small, dependency-free debounced watcher.
 * Intended for dev ergonomics (rebuild/restart), not for correctness-critical logic.
 */
export function watchDebounced({
  paths,
  debounceMs = 500,
  shouldObserve = null,
  onObservation = null,
  onChange,
  readSignature = null,
  pollIntervalMs = 0,
  watchImpl = watch,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = console,
} = {}) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) {
    logger.warn?.('[local] watch: no paths were configured; watcher not started.');
    return null;
  }
  if (typeof onChange !== 'function') {
    logger.error?.('[local] watch: onChange handler is missing; watcher not started.');
    return null;
  }

  let closed = false;
  let t = null;
  let pendingSignatureInitializedAtObservation = null;
  let pendingObservationHandled = false;
  const watchers = [];
  let lastSignature = null;
  let signatureInitialized = false;
  let initialSignaturePromise = null;
  if (typeof readSignature === 'function') {
    try {
      const initialSignature = readSignature();
      if (initialSignature && typeof initialSignature.then === 'function') {
        initialSignaturePromise = Promise.resolve(initialSignature).then((signature) => {
          if (closed) return;
          lastSignature = signature;
          signatureInitialized = true;
        }).catch((error) => {
          logger.warn?.(`[local] watch: initial signature read failed; filesystem events remain active: ${formatError(error)}`);
        });
      } else {
        lastSignature = initialSignature;
        signatureInitialized = true;
      }
    } catch (error) {
      lastSignature = null;
      logger.warn?.(`[local] watch: initial signature read failed; filesystem events remain active: ${formatError(error)}`);
    }
  }

  const trigger = (eventType, filename, details = {}) => {
    if (closed) return;
    const observation = { eventType, filename, ...details };
    if (typeof shouldObserve === 'function' && !shouldObserve(observation)) return;
    try {
      pendingObservationHandled = onObservation?.({
        ...observation,
        signatureInitializedAtObservation: signatureInitialized,
      }) === true || pendingObservationHandled;
    } catch (error) {
      logger.error?.(`[local] watch: observation handler failed; watcher remains active: ${formatError(error)}`);
    }
    pendingSignatureInitializedAtObservation = pendingSignatureInitializedAtObservation === false
      ? false
      : signatureInitialized;
    if (t) clearTimeoutImpl(t);
    t = setTimeoutImpl(() => {
      t = null;
      const signatureInitializedAtObservation = pendingSignatureInitializedAtObservation;
      const observationHandled = pendingObservationHandled;
      pendingSignatureInitializedAtObservation = null;
      pendingObservationHandled = false;
      Promise.resolve()
        .then(() => onChange({
          ...observation,
          signatureInitializedAtObservation,
          observationHandled,
        }))
        .catch((error) => {
          logger.error?.(`[local] watch: change handler failed; watcher remains active: ${formatError(error)}`);
        });
    }, debounceMs);
  };

  for (const p of list) {
    const w = safeWatch(
      p,
      (eventType, filename) => trigger(eventType, filename, { watchPath: p }),
      watchImpl,
      logger,
    );
    if (w) watchers.push(w);
  }

  const pollMs = Number(pollIntervalMs);
  let pollTimer = null;
  let polling = false;
  if (typeof readSignature === 'function' && Number.isFinite(pollMs) && pollMs > 0 && typeof setIntervalImpl === 'function') {
    const pollForSignatureChange = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        if (initialSignaturePromise) {
          await initialSignaturePromise;
          initialSignaturePromise = null;
          if (closed) return;
        }
        const nextSignature = await readSignature();
        if (!signatureInitialized) {
          lastSignature = nextSignature;
          signatureInitialized = true;
          return;
        }
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          trigger('poll', null, { signature: nextSignature });
        }
      } catch (error) {
        logger.warn?.(`[local] watch: signature poll failed; filesystem events remain active: ${formatError(error)}`);
      } finally {
        polling = false;
      }
    };
    pollTimer = setIntervalImpl(pollForSignatureChange, pollMs);
    pollTimer?.unref?.();
  }

  if (!watchers.length && !pollTimer) {
    logger.error?.('[local] watch: no active filesystem watcher or signature poller; watcher not started.');
    return null;
  }

  return {
    close() {
      closed = true;
      if (t) clearTimeoutImpl(t);
      pendingSignatureInitializedAtObservation = null;
      pendingObservationHandled = false;
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      if (pollTimer && typeof clearIntervalImpl === 'function') {
        try {
          clearIntervalImpl(pollTimer);
        } catch {
          // ignore
        }
      }
    },
  };
}
