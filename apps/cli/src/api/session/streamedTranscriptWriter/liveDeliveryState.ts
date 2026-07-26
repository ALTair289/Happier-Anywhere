import type {
  EphemeralSendFailureReason,
  EphemeralSendOutcome,
} from '../ephemeralSendOutcome';

export type LiveDeliveryIntent = Readonly<{
  state: 'streaming' | 'complete' | 'interrupted';
  interruptedReason?: string;
}>;

export type LocallyAcceptedLivePublication = Readonly<{
  text: string;
  tick: number;
  epoch: number;
  acceptedAtMs: number;
  lastCheckpointAtMs: number;
}>;

export type LiveDeliveryFailureState = {
  firstReason: EphemeralSendFailureReason;
  count: number;
  suppressedCount: number;
  lastFingerprint: string;
  lastLoggedAtMs: number;
};

export type LiveDeliveryState = {
  locallyAccepted: LocallyAcceptedLivePublication | null;
  appendOnlySinceLocallyAccepted: boolean;
  checkpointRequired: boolean;
  inFlight: Promise<void> | null;
  pending: LiveDeliveryIntent | null;
  failure: LiveDeliveryFailureState | null;
  disposed: boolean;
};

export function createLiveDeliveryState(): LiveDeliveryState {
  return {
    locallyAccepted: null,
    appendOnlySinceLocallyAccepted: true,
    checkpointRequired: false,
    inFlight: null,
    pending: null,
    failure: null,
    disposed: false,
  };
}

export function queueLiveDeliveryIntent(
  state: LiveDeliveryState,
  intent: LiveDeliveryIntent,
): void {
  if (state.disposed) return;
  if (state.pending && state.pending.state !== 'streaming' && intent.state === 'streaming') return;
  state.pending = intent;
}

export function takePendingLiveDeliveryIntent(state: LiveDeliveryState): LiveDeliveryIntent | null {
  if (state.disposed) return null;
  const pending = state.pending;
  state.pending = null;
  return pending;
}

export function hasDirtyLiveDeliveryText(state: LiveDeliveryState, text: string): boolean {
  const accepted = state.locallyAccepted;
  if (!accepted) return text.length > 0;
  if (state.appendOnlySinceLocallyAccepted) return text.length !== accepted.text.length;
  return text !== accepted.text;
}

export function markLiveDeliveryRewrite(state: LiveDeliveryState): void {
  state.appendOnlySinceLocallyAccepted = false;
  state.checkpointRequired = true;
}

export function shouldPublishLiveDelta(params: Readonly<{
  delivery: LiveDeliveryState;
  state: LiveDeliveryIntent['state'];
  nowMs: number;
  epoch: number;
  liveCheckpointIntervalMs: number;
  supportsDelta: boolean;
}>): boolean {
  const accepted = params.delivery.locallyAccepted;
  if (!params.supportsDelta || !accepted) return false;
  if (params.delivery.checkpointRequired) return false;
  if (!params.delivery.appendOnlySinceLocallyAccepted) return false;
  if (params.state !== 'streaming') return false;
  if (params.liveCheckpointIntervalMs <= 0) return false;
  if (accepted.epoch !== params.epoch) return false;
  if (params.nowMs - accepted.lastCheckpointAtMs >= params.liveCheckpointIntervalMs) return false;
  return true;
}

export function acceptLivePublication(params: Readonly<{
  delivery: LiveDeliveryState;
  text: string;
  tick: number;
  outcome: Extract<EphemeralSendOutcome, { accepted: true }>;
  attemptedEpoch: number;
  acceptedAtMs: number;
  wasCheckpoint: boolean;
}>): boolean {
  if (params.delivery.disposed) return false;
  if (!params.wasCheckpoint && params.outcome.epoch !== params.attemptedEpoch) {
    params.delivery.checkpointRequired = true;
    return false;
  }
  const previousCheckpointAtMs = params.delivery.locallyAccepted?.lastCheckpointAtMs ?? 0;
  params.delivery.locallyAccepted = {
    text: params.text,
    tick: params.tick,
    epoch: params.outcome.epoch,
    acceptedAtMs: params.acceptedAtMs,
    lastCheckpointAtMs: params.wasCheckpoint ? params.acceptedAtMs : previousCheckpointAtMs,
  };
  params.delivery.appendOnlySinceLocallyAccepted = true;
  params.delivery.checkpointRequired = false;
  return true;
}

function failureFingerprint(reason: EphemeralSendFailureReason): string {
  if (reason.code !== 'local_failure') return reason.code;
  return `${reason.code}:${reason.error.name}:${reason.error.message}`;
}

export function recordLiveDeliveryFailure(params: Readonly<{
  delivery: LiveDeliveryState;
  reason: EphemeralSendFailureReason;
  nowMs: number;
}>): { logFull: boolean; firstReason: EphemeralSendFailureReason; count: number } | null {
  if (params.delivery.disposed) return null;
  params.delivery.checkpointRequired = true;
  const fingerprint = failureFingerprint(params.reason);
  const existing = params.delivery.failure;
  if (!existing) {
    params.delivery.failure = {
      firstReason: params.reason,
      count: 1,
      suppressedCount: 0,
      lastFingerprint: fingerprint,
      lastLoggedAtMs: params.nowMs,
    };
    return { logFull: true, firstReason: params.reason, count: 1 };
  }

  existing.count += 1;
  const shouldLogFull = existing.lastFingerprint !== fingerprint
    || params.nowMs - existing.lastLoggedAtMs >= 30_000;
  if (shouldLogFull) {
    existing.lastFingerprint = fingerprint;
    existing.lastLoggedAtMs = params.nowMs;
  } else {
    existing.suppressedCount += 1;
  }
  return {
    logFull: shouldLogFull,
    firstReason: existing.firstReason,
    count: existing.count,
  };
}

export function takeLiveDeliveryRecoverySummary(
  state: LiveDeliveryState,
): Readonly<{ firstReason: EphemeralSendFailureReason; count: number; suppressedCount: number }> | null {
  const failure = state.failure;
  if (!failure) return null;
  state.failure = null;
  return {
    firstReason: failure.firstReason,
    count: failure.count,
    suppressedCount: failure.suppressedCount,
  };
}

export function disposeLiveDeliveryState(state: LiveDeliveryState): void {
  state.disposed = true;
  state.pending = null;
}
