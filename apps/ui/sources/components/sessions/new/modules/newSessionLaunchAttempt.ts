export type NewSessionLaunchAttemptStatus =
    | 'idle'
    | 'spawning'
    | 'created'
    | 'uploading_attachments'
    | 'sending_first_turn'
    | 'complete'
    | 'failed_retryable'
    | 'failed_fatal';

export type NewSessionLaunchAttemptFailurePhase =
    | 'spawning'
    | 'created'
    | 'uploading_attachments'
    | 'sending_first_turn';

export type NewSessionLaunchAttemptPhaseError = Readonly<{
    message: string;
    retryable: boolean;
}>;

export type NewSessionLaunchAttempt = Readonly<{
    attemptId: string;
    spawnNonce: string;
    scopeKey: string;
    spawnTargetFingerprint: string | null;
    createdSessionId: string | null;
    firstTurnLocalId: string;
    attachmentMessageLocalId: string;
    status: NewSessionLaunchAttemptStatus;
    prompt: Readonly<{
        prompt: string;
        displayText: string;
        meta: unknown;
    }>;
    phaseErrors: Partial<Record<NewSessionLaunchAttemptFailurePhase, NewSessionLaunchAttemptPhaseError>>;
}>;

type CreateNewSessionLaunchAttemptParams = Readonly<{
    prompt: string;
    displayText: string;
    scopeKey: string;
    meta?: unknown;
    attemptId?: string | null;
    spawnNonce?: string | null;
    createId?: (prefix: string) => string;
}>;

function defaultCreateId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createNewSessionLaunchAttempt(params: CreateNewSessionLaunchAttemptParams): NewSessionLaunchAttempt {
    const createId = params.createId ?? defaultCreateId;
    const attemptId = typeof params.attemptId === 'string' && params.attemptId.trim().length > 0
        ? params.attemptId.trim()
        : createId('attempt');
    const spawnNonce = typeof params.spawnNonce === 'string' && params.spawnNonce.trim().length > 0
        ? params.spawnNonce.trim()
        : createId('spawn');
    return {
        attemptId,
        spawnNonce,
        scopeKey: params.scopeKey,
        spawnTargetFingerprint: null,
        firstTurnLocalId: createId('first-turn'),
        attachmentMessageLocalId: createId('attachment-message'),
        createdSessionId: null,
        status: 'idle',
        prompt: {
            prompt: params.prompt,
            displayText: params.displayText,
            meta: params.meta ?? null,
        },
        phaseErrors: {},
    };
}

export function adoptNewSessionLaunchAttemptCustody(
    attempt: NewSessionLaunchAttempt,
    params: Readonly<{
        userAttemptId: string;
        spawnNonce: string;
        createdSessionId: string | null;
        firstTurnLocalId: string;
        attachmentMessageLocalId: string;
        targetFingerprint: string;
    }>,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        attemptId: params.userAttemptId,
        spawnNonce: params.spawnNonce,
        spawnTargetFingerprint: params.targetFingerprint,
        createdSessionId: params.createdSessionId ?? attempt.createdSessionId,
        firstTurnLocalId: params.firstTurnLocalId || attempt.firstTurnLocalId,
        attachmentMessageLocalId: params.attachmentMessageLocalId || attempt.attachmentMessageLocalId,
        ...(params.createdSessionId ? { status: 'created' as const } : {}),
    };
}

export function markNewSessionLaunchAttemptSendingFirstTurn(
    attempt: NewSessionLaunchAttempt,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        status: 'sending_first_turn',
    };
}

export function markNewSessionLaunchAttemptSpawning(
    attempt: NewSessionLaunchAttempt,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        status: 'spawning',
    };
}

export function markNewSessionLaunchAttemptCreated(
    attempt: NewSessionLaunchAttempt,
    params: Readonly<{ createdSessionId: string }>,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        createdSessionId: params.createdSessionId,
        status: 'created',
    };
}

export function markNewSessionLaunchAttemptComplete(
    attempt: NewSessionLaunchAttempt,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        status: 'complete',
    };
}

export function markNewSessionLaunchAttemptFailed(
    attempt: NewSessionLaunchAttempt,
    params: Readonly<{
        phase: NewSessionLaunchAttemptFailurePhase;
        error: unknown;
        retryable: boolean;
    }>,
): NewSessionLaunchAttempt {
    const message = params.error instanceof Error ? params.error.message : String(params.error);
    return {
        ...attempt,
        status: params.retryable ? 'failed_retryable' : 'failed_fatal',
        phaseErrors: {
            ...attempt.phaseErrors,
            [params.phase]: {
                message,
                retryable: params.retryable,
            },
        },
    };
}

export function shouldSpawnForNewSessionLaunchAttempt(attempt: NewSessionLaunchAttempt): boolean {
    return !attempt.createdSessionId;
}

export function isNewSessionLaunchAttemptInScope(
    attempt: NewSessionLaunchAttempt | null,
    scopeKey: string,
): attempt is NewSessionLaunchAttempt {
    return !!attempt && attempt.scopeKey === scopeKey;
}
