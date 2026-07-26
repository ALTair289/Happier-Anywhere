import { serializeOutboundError, type SerializedOutboundError } from './outboundErrorSerialization';

export type EphemeralSendFailureReason =
  | Readonly<{ code: 'socket_disconnected' }>
  | Readonly<{ code: 'transport_unavailable' }>
  | Readonly<{ code: 'local_failure'; error: SerializedOutboundError }>
  | Readonly<{ code: 'connection_epoch_changed' }>;

export type EphemeralSendOutcome =
  | Readonly<{ accepted: true; epoch: number }>
  | Readonly<{
    accepted: false;
    epoch: number;
    reason: EphemeralSendFailureReason;
  }>;

export type EphemeralSendResult = EphemeralSendOutcome | Promise<EphemeralSendOutcome>;

export function createDisconnectedEphemeralSendOutcome(epoch: number): EphemeralSendOutcome {
  return {
    accepted: false,
    epoch,
    reason: { code: 'socket_disconnected' },
  };
}

export function createUnavailableEphemeralSendOutcome(epoch: number): EphemeralSendOutcome {
  return {
    accepted: false,
    epoch,
    reason: { code: 'transport_unavailable' },
  };
}

function isSerializedOutboundError(value: unknown): value is SerializedOutboundError {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.message === 'string';
}

function isEphemeralSendFailureReason(value: unknown): value is EphemeralSendFailureReason {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    record.code === 'socket_disconnected'
    || record.code === 'transport_unavailable'
    || record.code === 'connection_epoch_changed'
  ) {
    return true;
  }
  return record.code === 'local_failure' && isSerializedOutboundError(record.error);
}

/**
 * Normalize the transport boundary instead of trusting proxy or adapter return values. A missing
 * or malformed outcome must never establish a live-delta base.
 */
export function normalizeEphemeralSendOutcome(value: unknown, fallbackEpoch: number): EphemeralSendOutcome {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.epoch === 'number' && Number.isFinite(record.epoch)) {
      const epoch = Math.max(0, Math.trunc(record.epoch));
      if (record.accepted === true) return { accepted: true, epoch };
      if (record.accepted === false && isEphemeralSendFailureReason(record.reason)) {
        return {
          accepted: false,
          epoch,
          reason: record.reason.code === 'local_failure'
            ? {
                code: 'local_failure',
                error: serializeOutboundError(record.reason.error),
              }
            : record.reason,
        };
      }
    }
  }
  return {
    accepted: false,
    epoch: fallbackEpoch,
    reason: {
      code: 'local_failure',
      error: serializeOutboundError(new Error('Ephemeral send returned an invalid acceptance outcome')),
    },
  };
}
