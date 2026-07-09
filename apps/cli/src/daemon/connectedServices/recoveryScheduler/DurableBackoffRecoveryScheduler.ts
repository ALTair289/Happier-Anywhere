import { sanitizeConnectedServiceDiagnosticString } from '../diagnostics/sanitizeConnectedServiceDiagnosticString';

export type DurableRecoveryStatus = 'waiting' | 'checking' | 'cancelled' | 'exhausted';

export type DurableRecoveryStore<TIntent> = Readonly<{
  read: (recoveryKey: string) => unknown | null;
  readAll?: () => ReadonlyArray<readonly [recoveryKey: string, value: unknown]>;
  write: (recoveryKey: string, intent: TIntent) => Promise<void> | void;
  remove?: (recoveryKey: string) => Promise<void> | void;
  prune?: (predicate: (entry: Readonly<{ recoveryKey: string; value: unknown }>) => boolean) => Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
}>;

export type DurableRecoveryOutcome<TIntent> =
  | Readonly<{ status: 'success'; intent?: TIntent }>
  | Readonly<{ status: 'wait'; nextRetryAtMs?: number | null; lastError?: string | null; intent?: TIntent; exhaustOnMaxAttempt?: boolean }>
  | Readonly<{ status: 'terminal'; lastError?: string | null; intent?: TIntent }>
  | Readonly<{ status: 'exhausted'; lastError?: string | null; intent?: TIntent }>
  // The recovery no longer applies (the condition it was armed for was superseded by other
  // progress, e.g. a group switch off the failing profile). The durable record is REMOVED —
  // not terminalized — so the same recovery key can re-arm on a genuine future failure
  // (a terminal record blocks re-arming for the whole retention window, RD-REC-13).
  | Readonly<{ status: 'superseded'; reason?: string | null }>;

export type DurableRecoveryGateResult =
  | Readonly<{ status: 'open' }>
  | Readonly<{ status: 'delayed'; retryAtMs: number; reason: string }>;

type DurableRecoveryWakeWriteReason =
  | 'delayed'
  | 'max_attempts_exhausted'
  | 'success'
  | 'terminal'
  | 'exhausted'
  | 'waiting';

type TimerHandle = ReturnType<typeof setTimeout>;

type DurableBackoffRecoverySchedulerDeps<TIntent> = Readonly<{
  nowMs: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: () => number;
  store?: DurableRecoveryStore<TIntent>;
  normalizeIntent: (value: unknown) => TIntent | null;
  getStatus: (intent: TIntent) => DurableRecoveryStatus;
  getNextRetryAtMs: (intent: TIntent) => number | null;
  getAttemptCount: (intent: TIntent) => number;
  getMaxAttempts: (intent: TIntent) => number;
  terminalRecordRetentionMs?: number;
  getTerminalPruneReferenceMs?: (intent: TIntent) => number | null;
  exhaustOnMaxAttemptOutcome?: boolean;
  markChecking: (intent: TIntent, attemptCount: number) => TIntent;
  markWaiting: (intent: TIntent, input: Readonly<{ nextRetryAtMs: number; lastError: string | null }>) => TIntent;
  markCancelled: (intent: TIntent) => TIntent;
  markExhausted: (intent: TIntent, input: Readonly<{ lastError: string | null }>) => TIntent;
  getSessionId?: (intent: TIntent) => string;
  recover: (intent: TIntent, context: Readonly<{ sessionId: string; reason: string }>) => Promise<DurableRecoveryOutcome<TIntent>>;
  mergeBeforeWakeWrite?: (input: Readonly<{
    recoveryKey: string;
    current: TIntent | null;
    base: TIntent;
    next: TIntent;
    reason: DurableRecoveryWakeWriteReason;
  }>) => TIntent;
  sanitizeLastError?: (value: string) => string;
  gate?: (input: Readonly<{ sessionId: string; intent: TIntent }>) => DurableRecoveryGateResult;
  onRetry?: (input: Readonly<{ sessionId: string; intent: TIntent; reason: string }>) => void;
  onSuccess?: (input: Readonly<{ sessionId: string; intent: TIntent }>) => Promise<void> | void;
  clearOnSuccess?: boolean;
  onTerminal?: (input: Readonly<{ sessionId: string; intent: TIntent; lastError: string | null }>) => void;
  onSuperseded?: (input: Readonly<{ sessionId: string; intent: TIntent; reason: string | null }>) => void;
  onExhausted?: (input: Readonly<{ sessionId: string; intent: TIntent; lastError: string | null }>) => void;
  onDelayed?: (input: Readonly<{ sessionId: string; intent: TIntent; retryAtMs: number; reason: string }>) => void;
}>;

const defaultBaseBackoffMs = 1_000;
const defaultMaxBackoffMs = 60_000;
const maxSafeTimerDelayMs = 2_147_483_647;

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeError(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export class DurableBackoffRecoveryScheduler<TIntent> {
  private readonly memoryStore = new Map<string, TIntent>();
  private readonly sessionIdByRecoveryKey = new Map<string, string>();
  private readonly timersByRecoveryKey = new Map<string, TimerHandle>();
  private readonly wakePromisesByRecoveryKey = new Map<string, Promise<Readonly<{ status: string }>>>();
  private readonly cancellationVersionsByRecoveryKey = new Map<string, number>();
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly terminalRecordRetentionMs: number | null;
  private disposed = false;

  constructor(private readonly deps: DurableBackoffRecoverySchedulerDeps<TIntent>) {
    this.baseBackoffMs = normalizePositiveInteger(deps.baseBackoffMs, defaultBaseBackoffMs);
    this.maxBackoffMs = Math.max(
      this.baseBackoffMs,
      normalizePositiveInteger(deps.maxBackoffMs, defaultMaxBackoffMs),
    );
    this.terminalRecordRetentionMs = typeof deps.terminalRecordRetentionMs === 'number' && Number.isFinite(deps.terminalRecordRetentionMs)
      ? Math.max(0, Math.trunc(deps.terminalRecordRetentionMs))
      : null;
  }

  private sanitizeLastError(value: string | null | undefined): string | null {
    const normalized = normalizeError(value);
    if (!normalized) return null;
    return this.deps.sanitizeLastError?.(normalized)
      ?? sanitizeConnectedServiceDiagnosticString(normalized);
  }

  async upsert(input: Readonly<{ sessionId: string; recoveryKey?: string; intent: TIntent }>): Promise<TIntent> {
    const recoveryKey = this.resolveRecoveryKey(input);
    this.sessionIdByRecoveryKey.set(recoveryKey, input.sessionId);
    await this.write(recoveryKey, input.intent);
    return input.intent;
  }

  async upsertByKey(input: Readonly<{ sessionId: string; recoveryKey: string; intent: TIntent }>): Promise<TIntent> {
    this.sessionIdByRecoveryKey.set(input.recoveryKey, input.sessionId);
    await this.write(input.recoveryKey, input.intent);
    return input.intent;
  }

  async upsertMerged(input: Readonly<{
    sessionId: string;
    recoveryKey?: string;
    intent: TIntent;
    merge: (previous: TIntent | null, next: TIntent) => TIntent;
  }>): Promise<TIntent> {
    const recoveryKey = this.resolveRecoveryKey(input);
    return await this.upsertMergedByKey({
      sessionId: input.sessionId,
      recoveryKey,
      intent: input.intent,
      merge: input.merge,
    });
  }

  async upsertMergedByKey(input: Readonly<{
    sessionId: string;
    recoveryKey: string;
    intent: TIntent;
    merge: (previous: TIntent | null, next: TIntent) => TIntent;
  }>): Promise<TIntent> {
    this.sessionIdByRecoveryKey.set(input.recoveryKey, input.sessionId);
    const previous = this.readByKey(input.recoveryKey);
    const merged = input.merge(previous, input.intent);
    await this.write(input.recoveryKey, merged);
    return merged;
  }

  read(sessionId: string): TIntent | null {
    return this.readByKey(sessionId);
  }

  readByKey(recoveryKey: string): TIntent | null {
    const stored = this.deps.store?.read(recoveryKey) ?? this.memoryStore.get(recoveryKey) ?? null;
    const intent = this.deps.normalizeIntent(stored);
    if (!intent) return null;
    this.memoryStore.set(recoveryKey, intent);
    this.schedule(recoveryKey, intent);
    return intent;
  }

  readForSession(sessionId: string): ReadonlyArray<TIntent> {
    const entries = this.readAllEntries();
    const intents: TIntent[] = [];
    for (const [recoveryKey, value] of entries) {
      const intent = this.deps.normalizeIntent(value);
      if (!intent) continue;
      const intentSessionId = this.resolveSessionIdForEntry(recoveryKey, intent);
      if (intentSessionId !== sessionId) continue;
      this.memoryStore.set(recoveryKey, intent);
      this.schedule(recoveryKey, intent);
      intents.push(intent);
    }
    if (intents.length > 0 || this.deps.getSessionId) return intents;
    const legacyIntent = this.read(sessionId);
    return legacyIntent ? [legacyIntent] : [];
  }

  hydrate(): ReadonlyArray<TIntent> {
    const entries = this.deps.store?.readAll?.() ?? [];
    const intents: TIntent[] = [];
    for (const [recoveryKey, value] of entries) {
      const intent = this.deps.normalizeIntent(value);
      if (!intent) continue;
      this.memoryStore.set(recoveryKey, intent);
      this.schedule(recoveryKey, intent);
      intents.push(intent);
    }
    return intents;
  }

  /**
   * Stop the scheduler's in-memory lifecycle: clear every per-key timer and set a
   * disposed flag so no timer fires and no new wake/schedule runs after disposal.
   *
   * This is a daemon-shutdown lifecycle method. It deliberately does NOT mutate any
   * optional store; callers choose whether their recovery records are process-local or
   * durable. Disposal only prevents a tearing-down daemon from firing timers into a
   * dying control endpoint.
   */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timersByRecoveryKey.values()) {
      clearTimeout(timer);
    }
    this.timersByRecoveryKey.clear();
  }

  /** Alias for `dispose()` for call sites that prefer `stop()` naming. */
  stop(): void {
    this.dispose();
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<TIntent | null> {
    return await this.cancelByKey(input.sessionId);
  }

  async cancelByKey(recoveryKey: string): Promise<TIntent | null> {
    const intent = this.readByKey(recoveryKey);
    if (!intent) return null;
    this.bumpCancellationVersion(recoveryKey);
    const cancelled = this.deps.markCancelled(intent);
    await this.write(recoveryKey, cancelled);
    this.clearTimer(recoveryKey);
    return cancelled;
  }

  async clearByKey(recoveryKey: string): Promise<TIntent | null> {
    const intent = this.readByKey(recoveryKey);
    if (!intent) return null;
    this.bumpCancellationVersion(recoveryKey);
    await this.remove(recoveryKey);
    this.clearTimer(recoveryKey);
    return intent;
  }

  async pruneTerminalRecords(): Promise<ReadonlyArray<string>> {
    if (this.terminalRecordRetentionMs === null || !this.deps.getTerminalPruneReferenceMs) return [];
    const cutoffMs = this.deps.nowMs() - this.terminalRecordRetentionMs;
    const shouldPrune = (value: unknown): boolean => {
      const intent = this.deps.normalizeIntent(value);
      if (!intent) return false;
      const status = this.deps.getStatus(intent);
      if (status !== 'cancelled' && status !== 'exhausted') return false;
      const referenceMs = this.deps.getTerminalPruneReferenceMs?.(intent);
      return typeof referenceMs === 'number' && Number.isFinite(referenceMs) && referenceMs <= cutoffMs;
    };
    const prunedKeys = this.deps.store?.prune
      ? await this.deps.store.prune(({ value }) => shouldPrune(value))
      : await this.pruneTerminalRecordsWithRemove(shouldPrune);
    for (const recoveryKey of prunedKeys) {
      this.memoryStore.delete(recoveryKey);
      this.sessionIdByRecoveryKey.delete(recoveryKey);
      this.clearTimer(recoveryKey);
    }
    return prunedKeys;
  }

  async cancelForSession(sessionId: string): Promise<ReadonlyArray<TIntent>> {
    const entries = this.readEntriesForSession(sessionId);
    const cancelled: TIntent[] = [];
    for (const [recoveryKey, intent] of entries) {
      this.bumpCancellationVersion(recoveryKey);
      const nextIntent = this.deps.markCancelled(intent);
      await this.write(recoveryKey, nextIntent);
      this.clearTimer(recoveryKey);
      cancelled.push(nextIntent);
    }
    return cancelled;
  }

  async wake(input: Readonly<{ sessionId: string; reason: string }>): Promise<Readonly<{ status: string }>> {
    return await this.wakeByKey({
      recoveryKey: input.sessionId,
      reason: input.reason,
      sessionId: input.sessionId,
    });
  }

  async wakeByKey(input: Readonly<{
    recoveryKey: string;
    reason: string;
    sessionId?: string;
  }>): Promise<Readonly<{ status: string }>> {
    const existing = this.wakePromisesByRecoveryKey.get(input.recoveryKey);
    if (existing) return await existing;
    const wakePromise = this.performWake(input);
    this.wakePromisesByRecoveryKey.set(input.recoveryKey, wakePromise);
    try {
      return await wakePromise;
    } finally {
      if (this.wakePromisesByRecoveryKey.get(input.recoveryKey) === wakePromise) {
        this.wakePromisesByRecoveryKey.delete(input.recoveryKey);
      }
    }
  }

  private async performWake(input: Readonly<{
    recoveryKey: string;
    reason: string;
    sessionId?: string;
  }>): Promise<Readonly<{ status: string }>> {
    // Disposed (daemon shutting down): never run recovery work. Any optional store is
    // left untouched; caller wiring decides whether those records outlive the process.
    if (this.disposed) return { status: 'disposed' };
    const intent = this.readByKey(input.recoveryKey);
    if (!intent) return { status: 'inactive' };
    const sessionId = input.sessionId ?? this.resolveSessionIdForEntry(input.recoveryKey, intent);

    const status = this.deps.getStatus(intent);
    if (status === 'cancelled') return { status: 'inactive' };
    if (status === 'exhausted') return { status: 'exhausted' };

    const nowMs = this.deps.nowMs();
    const nextRetryAtMs = this.deps.getNextRetryAtMs(intent);
    if (input.reason === 'timer' && status === 'waiting' && nextRetryAtMs !== null && nowMs < nextRetryAtMs) {
      this.schedule(input.recoveryKey, intent);
      return { status: 'waiting' };
    }

    const cancellationVersion = this.getCancellationVersion(input.recoveryKey);
    const gate = this.deps.gate?.({ sessionId, intent });
    if (gate?.status === 'delayed') {
      const delayed = this.prepareWakeWrite(input.recoveryKey, {
        base: intent,
        next: this.deps.markWaiting(intent, {
          nextRetryAtMs: gate.retryAtMs,
          lastError: this.sanitizeLastError(gate.reason),
        }),
        reason: 'delayed',
      });
      await this.write(input.recoveryKey, delayed);
      this.deps.onDelayed?.({
        sessionId,
        intent: delayed,
        retryAtMs: gate.retryAtMs,
        reason: gate.reason,
      });
      return { status: 'waiting' };
    }

    const maxAttempts = this.deps.getMaxAttempts(intent);
    if (maxAttempts > 0 && this.deps.getAttemptCount(intent) >= maxAttempts) {
      const exhaustedAttempt = this.deps.markChecking(intent, this.deps.getAttemptCount(intent) + 1);
      const exhausted = this.prepareWakeWrite(input.recoveryKey, {
        base: intent,
        next: this.deps.markExhausted(exhaustedAttempt, { lastError: 'max_attempts_exhausted' }),
        reason: 'max_attempts_exhausted',
      });
      await this.write(input.recoveryKey, exhausted);
      this.clearTimer(input.recoveryKey);
      this.deps.onExhausted?.({
        sessionId,
        intent: exhausted,
        lastError: 'max_attempts_exhausted',
      });
      return { status: 'exhausted' };
    }

    const attemptCount = this.deps.getAttemptCount(intent) + 1;
    const checking = this.deps.markChecking(intent, attemptCount);
    await this.write(input.recoveryKey, checking);
    if (this.wasCancelledSince(input.recoveryKey, cancellationVersion)) {
      this.clearTimer(input.recoveryKey);
      return { status: 'inactive' };
    }
    this.deps.onRetry?.({
      sessionId,
      intent: checking,
      reason: input.reason,
    });

    let outcome: DurableRecoveryOutcome<TIntent>;
    try {
      outcome = await this.deps.recover(checking, { sessionId, reason: input.reason });
    } catch (error) {
      outcome = {
        status: 'wait',
        lastError: this.sanitizeLastError(error instanceof Error ? error.message : String(error)) ?? 'recovery_failed',
      };
    }

    if (this.wasCancelledSince(input.recoveryKey, cancellationVersion)) {
      this.clearTimer(input.recoveryKey);
      return { status: 'inactive' };
    }

    if (outcome.status === 'success') {
      const succeeded = this.prepareWakeWrite(input.recoveryKey, {
        base: checking,
        next: outcome.intent ?? (this.deps.clearOnSuccess ? checking : this.deps.markCancelled(checking)),
        reason: 'success',
      });
      if (this.deps.clearOnSuccess && this.deps.getStatus(succeeded) !== 'cancelled' && this.deps.getStatus(succeeded) !== 'exhausted') {
        await this.remove(input.recoveryKey);
        this.clearTimer(input.recoveryKey);
        await this.deps.onSuccess?.({ sessionId, intent: succeeded });
        return { status: 'succeeded' };
      }
      await this.write(input.recoveryKey, succeeded);
      this.clearTimer(input.recoveryKey);
      await this.deps.onSuccess?.({ sessionId, intent: succeeded });
      return { status: 'succeeded' };
    }

    if (outcome.status === 'superseded') {
      await this.remove(input.recoveryKey);
      this.clearTimer(input.recoveryKey);
      this.deps.onSuperseded?.({
        sessionId,
        intent: checking,
        reason: normalizeError(outcome.reason),
      });
      return { status: 'superseded' };
    }

    if (outcome.status === 'terminal') {
      const terminal = this.prepareWakeWrite(input.recoveryKey, {
        base: checking,
        next: outcome.intent ?? this.deps.markCancelled(checking),
        reason: 'terminal',
      });
      const lastError = this.sanitizeLastError(outcome.lastError);
      await this.write(input.recoveryKey, terminal);
      this.clearTimer(input.recoveryKey);
      this.deps.onTerminal?.({ sessionId, intent: terminal, lastError });
      return { status: 'terminal' };
    }

    const exhaustAfterOutcome = outcome.status === 'wait' && outcome.exhaustOnMaxAttempt === false
      ? false
      : this.deps.exhaustOnMaxAttemptOutcome !== false;
    // Honor an outcome-provided intent's attempt count: recover loops may roll the
    // markChecking increment back for outcomes that must not consume the attempt
    // budget (degraded local outages, durable group-exhausted waits). Exhaustion
    // must respect that rollback, or a durable wait reached AT the ceiling still
    // dead-letters even though the recover loop asked to keep waiting (F0).
    const settledAttemptCount = outcome.intent === undefined
      ? attemptCount
      : this.deps.getAttemptCount(outcome.intent);
    if (outcome.status === 'exhausted' || (exhaustAfterOutcome && maxAttempts > 0 && settledAttemptCount >= maxAttempts)) {
      const lastError = this.sanitizeLastError(outcome.lastError) ?? 'max_attempts_exhausted';
      const exhausted = this.prepareWakeWrite(input.recoveryKey, {
        base: checking,
        next: this.deps.markExhausted(outcome.intent ?? checking, { lastError }),
        reason: 'exhausted',
      });
      await this.write(input.recoveryKey, exhausted);
      this.clearTimer(input.recoveryKey);
      this.deps.onExhausted?.({ sessionId, intent: exhausted, lastError });
      return { status: 'exhausted' };
    }

    const explicitNextRetryAtMs = typeof outcome.nextRetryAtMs === 'number' && Number.isFinite(outcome.nextRetryAtMs)
      ? Math.max(0, Math.trunc(outcome.nextRetryAtMs))
      : null;
    const waiting = this.deps.markWaiting(outcome.intent ?? checking, {
      nextRetryAtMs: explicitNextRetryAtMs ?? nowMs + this.computeBackoffMs(attemptCount),
      lastError: this.sanitizeLastError(outcome.lastError),
    });
    await this.write(input.recoveryKey, this.prepareWakeWrite(input.recoveryKey, {
      base: checking,
      next: waiting,
      reason: 'waiting',
    }));
    return { status: 'waiting' };
  }

  private resolveRecoveryKey(input: Readonly<{ sessionId: string; recoveryKey?: string }>): string {
    return input.recoveryKey ?? input.sessionId;
  }

  private readAllEntries(): ReadonlyArray<readonly [recoveryKey: string, value: unknown]> {
    const storeEntries = this.deps.store?.readAll?.() ?? [];
    if (storeEntries.length > 0) return storeEntries;
    return [...this.memoryStore.entries()];
  }

  private readEntriesForSession(sessionId: string): ReadonlyArray<readonly [recoveryKey: string, intent: TIntent]> {
    const entries: Array<readonly [string, TIntent]> = [];
    for (const [recoveryKey, value] of this.readAllEntries()) {
      const intent = this.deps.normalizeIntent(value);
      if (!intent) continue;
      const intentSessionId = this.resolveSessionIdForEntry(recoveryKey, intent);
      if (intentSessionId !== sessionId) continue;
      entries.push([recoveryKey, intent]);
    }
    if (entries.length > 0 || this.deps.getSessionId) return entries;
    const legacyIntent = this.read(sessionId);
    return legacyIntent ? [[sessionId, legacyIntent]] : [];
  }

  private getCancellationVersion(recoveryKey: string): number {
    return this.cancellationVersionsByRecoveryKey.get(recoveryKey) ?? 0;
  }

  private resolveSessionIdForEntry(recoveryKey: string, intent: TIntent): string {
    return this.deps.getSessionId?.(intent)
      ?? this.sessionIdByRecoveryKey.get(recoveryKey)
      ?? recoveryKey;
  }

  private bumpCancellationVersion(recoveryKey: string): void {
    this.cancellationVersionsByRecoveryKey.set(recoveryKey, this.getCancellationVersion(recoveryKey) + 1);
  }

  private wasCancelledSince(recoveryKey: string, cancellationVersion: number): boolean {
    return this.getCancellationVersion(recoveryKey) !== cancellationVersion;
  }

  private computeBackoffMs(attemptCount: number): number {
    const exponential = this.baseBackoffMs * (2 ** Math.max(0, attemptCount));
    const jitter = Math.max(0, Math.trunc(this.deps.jitterMs?.() ?? 0));
    return Math.min(this.maxBackoffMs, exponential) + jitter;
  }

  private async write(recoveryKey: string, intent: TIntent): Promise<void> {
    await this.pruneTerminalRecords();
    this.memoryStore.set(recoveryKey, intent);
    await this.deps.store?.write(recoveryKey, intent);
    this.schedule(recoveryKey, intent);
  }

  private async remove(recoveryKey: string): Promise<void> {
    this.memoryStore.delete(recoveryKey);
    this.sessionIdByRecoveryKey.delete(recoveryKey);
    await this.deps.store?.remove?.(recoveryKey);
  }

  private async pruneTerminalRecordsWithRemove(
    predicate: (value: unknown) => boolean,
  ): Promise<ReadonlyArray<string>> {
    if (!this.deps.store?.readAll || !this.deps.store.remove) return [];
    const prunedKeys: string[] = [];
    for (const [recoveryKey, value] of this.deps.store.readAll()) {
      if (!predicate(value)) continue;
      await this.deps.store.remove(recoveryKey);
      prunedKeys.push(recoveryKey);
    }
    return prunedKeys;
  }

  private readCurrentWithoutScheduling(recoveryKey: string): TIntent | null {
    const stored = this.deps.store?.read(recoveryKey) ?? this.memoryStore.get(recoveryKey) ?? null;
    return this.deps.normalizeIntent(stored);
  }

  private prepareWakeWrite(
    recoveryKey: string,
    input: Readonly<{
      base: TIntent;
      next: TIntent;
      reason: DurableRecoveryWakeWriteReason;
    }>,
  ): TIntent {
    const merge = this.deps.mergeBeforeWakeWrite;
    if (!merge) return input.next;
    return merge({
      recoveryKey,
      current: this.readCurrentWithoutScheduling(recoveryKey),
      base: input.base,
      next: input.next,
      reason: input.reason,
    });
  }

  private clearTimer(recoveryKey: string): void {
    const timer = this.timersByRecoveryKey.get(recoveryKey);
    if (!timer) return;
    clearTimeout(timer);
    this.timersByRecoveryKey.delete(recoveryKey);
  }

  private schedule(recoveryKey: string, intent: TIntent): void {
    this.clearTimer(recoveryKey);
    // Disposed: do not arm any new timer. `readByKey`/`hydrate` may still be called
    // during teardown, and those call `schedule`; we must not resurrect timers.
    if (this.disposed) return;
    const status = this.deps.getStatus(intent);
    if (status !== 'waiting' && status !== 'checking') return;
    const nextRetryAtMs = status === 'checking'
      ? this.deps.nowMs()
      : this.deps.getNextRetryAtMs(intent);
    if (typeof nextRetryAtMs !== 'number' || !Number.isFinite(nextRetryAtMs)) return;
    const delayMs = Math.min(maxSafeTimerDelayMs, Math.max(0, nextRetryAtMs - this.deps.nowMs()));
    const timer = setTimeout(() => {
      this.timersByRecoveryKey.delete(recoveryKey);
      void this.wakeByKey({ recoveryKey, reason: 'timer' }).catch(() => {});
    }, delayMs);
    timer.unref?.();
    this.timersByRecoveryKey.set(recoveryKey, timer);
  }
}
