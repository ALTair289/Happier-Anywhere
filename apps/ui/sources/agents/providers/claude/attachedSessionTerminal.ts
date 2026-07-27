import type { Session } from '@/sync/domains/state/storageTypes';

export function isClaudeUnifiedAttachedSessionTerminalAvailable(
    session: Session,
): boolean {
    const localControl = session.agentState?.localControl;
    const terminal = session.metadata?.terminal;
    const serviceability = terminal?.controlServiceabilityV1;
    const attachmentId = serviceability?.attachmentId;

    return session.active === true
        && localControl?.attached === true
        && localControl.topology === 'shared'
        && localControl.canAttach === true
        && terminal?.mode !== undefined
        && terminal.mode !== 'plain'
        && serviceability?.v === 1
        && serviceability.state === 'servable'
        && serviceability.retired !== true
        && typeof attachmentId === 'string'
        && attachmentId.trim().length > 0;
}
