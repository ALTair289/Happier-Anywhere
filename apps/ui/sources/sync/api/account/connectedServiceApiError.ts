import { HappyError } from '@/utils/errors/errors';

export type ConnectedServiceApiErrorFields = Readonly<{
  code: string;
  status?: number;
  resetAtMs?: number;
  generation?: number;
  canTryAgain?: boolean;
  credentialRevision?: string | null;
  reason?: 'revision_mismatch' | 'refresh_lease_lost';
}>;

export class ConnectedServiceApiError extends HappyError {
  readonly resetAtMs?: number;
  readonly generation?: number;
  readonly credentialRevision?: string | null;
  readonly reason?: 'revision_mismatch' | 'refresh_lease_lost';

  constructor(fields: ConnectedServiceApiErrorFields) {
    super(fields.code, fields.canTryAgain === true, { status: fields.status, kind: 'server', code: fields.code });
    this.name = 'ConnectedServiceApiError';
    this.resetAtMs = fields.resetAtMs;
    this.generation = fields.generation;
    this.credentialRevision = fields.credentialRevision;
    this.reason = fields.reason;
    Object.setPrototypeOf(this, ConnectedServiceApiError.prototype);
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readConnectErrorCode(json: unknown, fallbackCode: string): string {
  const record = readRecord(json);
  const error = typeof record?.error === 'string' ? record.error : '';
  if (error.startsWith('connect_')) return error;
  const code = typeof record?.code === 'string' ? record.code : '';
  if (code.startsWith('connect_')) return code;
  return fallbackCode;
}

function readNumberField(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRetryableConnectedServiceStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
}

export function createConnectedServiceApiError(
  json: unknown,
  opts: Readonly<{ status?: number; fallbackCode: string }>,
): ConnectedServiceApiError {
  const record = readRecord(json);
  return new ConnectedServiceApiError({
    code: readConnectErrorCode(json, opts.fallbackCode),
    status: opts.status,
    resetAtMs: readNumberField(record, 'resetAtMs'),
    generation: readNumberField(record, 'generation'),
    canTryAgain: isRetryableConnectedServiceStatus(opts.status),
    credentialRevision: typeof record?.credentialRevision === 'string' || record?.credentialRevision === null
      ? record.credentialRevision
      : undefined,
    reason: record?.reason === 'revision_mismatch' || record?.reason === 'refresh_lease_lost'
      ? record.reason
      : undefined,
  });
}

export function readConnectedServiceApiErrorFields(error: unknown): ConnectedServiceApiErrorFields | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string'
    ? record.code
    : error instanceof Error && error.message.startsWith('connect_')
      ? error.message
      : '';
  if (!code) return null;
  return {
    code,
    status: typeof record.status === 'number' && Number.isFinite(record.status) ? record.status : undefined,
    resetAtMs: typeof record.resetAtMs === 'number' && Number.isFinite(record.resetAtMs) ? record.resetAtMs : undefined,
    generation: typeof record.generation === 'number' && Number.isFinite(record.generation) ? record.generation : undefined,
    credentialRevision: typeof record.credentialRevision === 'string' || record.credentialRevision === null
      ? record.credentialRevision
      : undefined,
    reason: record.reason === 'revision_mismatch' || record.reason === 'refresh_lease_lost'
      ? record.reason
      : undefined,
  };
}

export function isConnectedServiceApiErrorCode(error: unknown, code: string): boolean {
  return readConnectedServiceApiErrorFields(error)?.code === code;
}
