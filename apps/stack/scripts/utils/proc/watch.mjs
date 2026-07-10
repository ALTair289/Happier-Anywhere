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
  onChange,
  readSignature = null,
  pollIntervalMs = 0,
  watchImpl = watch,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
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
  const watchers = [];
  let lastSignature = null;
  if (typeof readSignature === 'function') {
    try {
      lastSignature = readSignature();
    } catch (error) {
      lastSignature = null;
      logger.warn?.(`[local] watch: initial signature read failed; filesystem events remain active: ${formatError(error)}`);
    }
  }

  const trigger = (eventType, filename) => {
    if (closed) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      Promise.resolve()
        .then(() => onChange({ eventType, filename }))
        .catch((error) => {
          logger.error?.(`[local] watch: change handler failed; watcher remains active: ${formatError(error)}`);
        });
    }, debounceMs);
  };

  for (const p of list) {
    const w = safeWatch(p, trigger, watchImpl, logger);
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
        const nextSignature = readSignature();
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          trigger('poll', null);
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
      if (t) clearTimeout(t);
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
