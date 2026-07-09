import type { QueuedSessionMutation } from './sessionMutationTypes';

export function isAuthoritativeSessionMutationKind(kind: QueuedSessionMutation['kind']): boolean {
    return kind === 'session_turn' || kind === 'session_end';
}

export function isAuthoritativeSessionMutation(mutation: QueuedSessionMutation): boolean {
    return isAuthoritativeSessionMutationKind(mutation.kind);
}
