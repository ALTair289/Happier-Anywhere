import type { QueuedSessionMutation } from './sessionMutationTypes';

export function isAuthoritativeSessionMutationKind(kind: QueuedSessionMutation['kind']): boolean {
    return kind === 'session_turn'
        || kind === 'transcript_message_append'
        || kind === 'runtime_activity_snapshot';
}

export function isAuthoritativeSessionMutation(mutation: QueuedSessionMutation): boolean {
    return isAuthoritativeSessionMutationKind(mutation.kind);
}
