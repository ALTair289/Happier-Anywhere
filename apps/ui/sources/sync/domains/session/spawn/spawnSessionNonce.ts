import { randomUUID } from '@/platform/randomUUID';

const UI_SESSION_SPAWN_NONCE_PREFIX = 'ui-session-spawn-';
const UI_SESSION_SPAWN_USER_ATTEMPT_PREFIX = 'ui-session-attempt-';

export function normalizeSpawnSessionNonce(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return value.trim().length > 0 ? value : null;
}

export function createUiSessionSpawnNonce(): string {
    return `${UI_SESSION_SPAWN_NONCE_PREFIX}${randomUUID().trim()}`;
}

export function createUiSessionSpawnUserAttemptId(): string {
    return `${UI_SESSION_SPAWN_USER_ATTEMPT_PREFIX}${randomUUID().trim()}`;
}
