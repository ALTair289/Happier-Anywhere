import { createHash } from 'node:crypto';

export const HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY = 'HAPPIER_DAEMON_PENDING_FIRST_INPUT';

export type PendingFirstInput = Readonly<{
  text: string;
  localId: string;
}>;

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Pending first input ${field} must not be blank`);
  }
  return value;
}

export function createPendingFirstInput(params: Readonly<{
  text: string;
  spawnNonce: string;
}>): PendingFirstInput {
  const text = requireNonBlank(params.text, 'text');
  const spawnNonce = requireNonBlank(params.spawnNonce, 'spawn nonce').trim();
  const identity = createHash('sha256')
    .update('happier:pending-first-input:v1\0', 'utf8')
    .update(spawnNonce, 'utf8')
    .digest('hex');
  return Object.freeze({ text, localId: `spawn-first:${identity}` });
}

export function serializePendingFirstInputForEnv(input: PendingFirstInput): string {
  return JSON.stringify({
    text: requireNonBlank(input.text, 'text'),
    localId: requireNonBlank(input.localId, 'localId'),
  });
}

export function readPendingFirstInputFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PendingFirstInput | null {
  const raw = env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Pending first input handoff is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pending first input handoff is malformed');
  }
  const value = parsed as Record<string, unknown>;
  return Object.freeze({
    text: requireNonBlank(value.text, 'text'),
    localId: requireNonBlank(value.localId, 'localId'),
  });
}

export function clearPendingFirstInputFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
}
