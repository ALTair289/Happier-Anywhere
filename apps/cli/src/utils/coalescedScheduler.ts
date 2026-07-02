/**
 * Provider-agnostic coalescing scheduler.
 *
 * Guarantees a single in-flight `drain()` at a time. Triggers that arrive while a drain is running
 * are collapsed into exactly one follow-up drain (latest-wins is the caller's responsibility — the
 * scheduler only coalesces invocations). This is the shared async primitive reused by the workflow
 * activity publisher and mirrors `../dev`'s `plugins/runtime/lifecycle/coalescedScheduler.ts` so the
 * two repos drain identically. Keep it generic: never bake provider- or workflow-specific behavior
 * in here.
 */
export type CoalescedScheduler = Readonly<{
  /** Request a drain. Runs immediately when idle, otherwise schedules exactly one follow-up. */
  trigger(): void;
  /** Stop scheduling. Any in-flight drain finishes, but no queued follow-up runs after dispose. */
  dispose(): void;
}>;

export function createCoalescedScheduler(params: Readonly<{
  drain: () => Promise<void>;
  onError?: (error: unknown) => void;
}>): CoalescedScheduler {
  let active = false;
  let queued = false;
  let disposed = false;

  async function run(): Promise<void> {
    if (active || disposed) {
      queued = true;
      return;
    }
    active = true;
    try {
      do {
        queued = false;
        await params.drain();
      } while (queued && !disposed);
    } catch (error) {
      params.onError?.(error);
    } finally {
      active = false;
    }
  }

  return Object.freeze({
    trigger() {
      void run();
    },
    dispose() {
      disposed = true;
      queued = false;
    },
  });
}
