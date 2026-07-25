import {
    CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
    parseClientCompatibilitySocketAuthV1,
    type ClientKind,
    type ClientCompatibilityDeclarationParseResult,
} from '@happier-dev/protocol';

import { evaluateSessionSyncCompatibility, type SessionSyncCompatibilityEvaluation } from './decision';
import { resolveSessionSyncCompatibilityPolicy } from './policy';
import { recordSessionSyncCompatibilityDecision } from './telemetry';

export interface SessionSyncSocketCompatibilityResult {
    readonly parseResult: ClientCompatibilityDeclarationParseResult;
    readonly evaluation: SessionSyncCompatibilityEvaluation;
}

export type SessionSyncCompatibilitySocketClientType = 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;

const USER_SCOPED_CLIENT_KINDS = Object.freeze([
    'ui-web',
    'ui-ios',
    'ui-android',
    'ui-desktop',
    'session-runner',
] satisfies readonly ClientKind[]);

export function sessionSyncCompatibilityConstraintsForSocketType(
    clientType: SessionSyncCompatibilitySocketClientType,
): { readonly allowedClientKinds: readonly ClientKind[] } {
    return {
        allowedClientKinds: clientType === 'session-scoped'
            ? ['session-runner']
            : clientType === 'machine-scoped'
                ? ['daemon']
                : USER_SCOPED_CLIENT_KINDS,
    };
}

export function evaluateSessionSyncSocketCompatibility(
    auth: unknown,
    env: NodeJS.ProcessEnv,
    clientType: SessionSyncCompatibilitySocketClientType = undefined,
): SessionSyncSocketCompatibilityResult {
    const parseResult = parseClientCompatibilitySocketAuthV1(auth);
    return {
        parseResult,
        evaluation: revalidateSessionSyncSocketCompatibility(parseResult, env, clientType),
    };
}

/**
 * Reuses the handshake parse result but resolves the current policy again at
 * privileged operation boundaries, fencing any observe-era socket missed by R2 drain.
 */
export function revalidateSessionSyncSocketCompatibility(
    parseResult: ClientCompatibilityDeclarationParseResult,
    env: NodeJS.ProcessEnv,
    clientType: SessionSyncCompatibilitySocketClientType = undefined,
): SessionSyncCompatibilityEvaluation {
    const evaluation = evaluateSessionSyncCompatibility(
        parseResult,
        resolveSessionSyncCompatibilityPolicy(env),
        sessionSyncCompatibilityConstraintsForSocketType(clientType),
    );
    recordSessionSyncCompatibilityDecision('socket', evaluation);
    return evaluation;
}

export function buildSessionSyncSocketUpgradeError(
    evaluation: SessionSyncCompatibilityEvaluation,
): Error & { data: unknown } {
    if (evaluation.upgradeRequired === null) {
        throw new Error('Cannot build an upgrade error for an accepted compatibility decision');
    }
    const error = new Error(CLIENT_UPGRADE_REQUIRED_ERROR_CODE) as Error & { data: unknown };
    error.data = evaluation.upgradeRequired;
    return error;
}
