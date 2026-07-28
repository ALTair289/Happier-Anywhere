import type { NormalizedMessage } from '../../typesRaw';

export function readAcpToolCallSnapshotRevision(input: unknown): number | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const acp = (input as { _acp?: unknown })._acp;
    if (!acp || typeof acp !== 'object' || Array.isArray(acp)) return null;
    const revision = (acp as { snapshotRevision?: unknown }).snapshotRevision;
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
        ? revision
        : null;
}

export function readMessageToolSnapshotRevision(message: NormalizedMessage): number | null {
    if (message.role !== 'agent') return null;
    let latest: number | null = null;
    for (const content of message.content) {
        if (content.type !== 'tool-call') continue;
        const revision = readAcpToolCallSnapshotRevision(content.input);
        if (revision !== null) latest = latest === null ? revision : Math.max(latest, revision);
    }
    return latest;
}
