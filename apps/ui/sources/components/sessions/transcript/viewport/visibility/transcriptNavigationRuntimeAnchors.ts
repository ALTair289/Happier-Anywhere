import type { TranscriptNavigationAnchorCandidate } from './deriveCurrentTranscriptAnchor';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationRole,
} from '../../navigation/transcriptNavigationTypes';

export type TranscriptNavigationRuntimeAnchorMessage = Readonly<{
    messageId: string;
    routeMessageId: string | null;
    seq: number | null;
    transcriptBlockIndex: number | null;
    role: TranscriptNavigationRole;
}>;

export type TranscriptNavigationRenderedAnchorSource = Readonly<{
    sourceIndex: number;
    messageIds: readonly string[];
    messages: readonly TranscriptNavigationRuntimeAnchorMessage[];
}>;

export type TranscriptNavigationRuntimeAnchor = TranscriptNavigationAnchorCandidate & Readonly<{
    messageIds: readonly string[];
}>;

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

function normalizeRole(role: TranscriptNavigationRole | null | undefined): TranscriptNavigationRole {
    if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
    return 'unknown';
}

function dedupeStrings(values: readonly unknown[]): readonly string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const normalized = normalizeString(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

function sourceMatchesEntry(
    source: TranscriptNavigationRenderedAnchorSource,
    entry: TranscriptNavigationEntry,
): boolean {
    const entryRouteMessageId = normalizeString(entry.routeMessageId);
    const entrySeq = normalizeInteger(entry.seq);
    const entryBlockIndex = normalizeInteger(entry.transcriptBlockIndex);
    const entryRole = normalizeRole(entry.role);
    const matchesEntryRowProof = (message: TranscriptNavigationRuntimeAnchorMessage): boolean => {
        if (entrySeq !== null && normalizeInteger(message.seq) !== entrySeq) return false;
        if (entryRole !== 'unknown' && normalizeRole(message.role) !== entryRole) return false;
        const messageBlockIndex = normalizeInteger(message.transcriptBlockIndex);
        return entryBlockIndex === null || messageBlockIndex === entryBlockIndex;
    };

    if (entryRouteMessageId) {
        return source.messages.some((message) => (
            (
                normalizeString(message.routeMessageId) === entryRouteMessageId ||
                normalizeString(message.messageId) === entryRouteMessageId
            ) &&
            matchesEntryRowProof(message)
        ));
    }

    if (entrySeq === null) return false;
    return source.messages.some((message) => {
        if (normalizeInteger(message.seq) !== entrySeq) return false;
        if (entryRole !== 'unknown' && normalizeRole(message.role) !== entryRole) return false;
        const messageBlockIndex = normalizeInteger(message.transcriptBlockIndex);
        return entryBlockIndex === null || messageBlockIndex === entryBlockIndex;
    });
}

/**
 * Resolves the MOST SPECIFIC rendered row for an entry. A group header row
 * carries every message id in the group, so a first-match scan hands a pinned
 * tool the group's source index — and a second pinned tool in the same group
 * then resolves to the identical anchor. Fewer message ids means a narrower
 * row, so the tool's own `tool-group-tool` item wins over its header; ties keep
 * the earliest rendered row.
 */
function resolveMostSpecificSourceForEntry(
    renderedSources: readonly TranscriptNavigationRenderedAnchorSource[],
    entry: TranscriptNavigationEntry,
): TranscriptNavigationRenderedAnchorSource | null {
    let best: TranscriptNavigationRenderedAnchorSource | null = null;
    let bestSpecificity = Number.POSITIVE_INFINITY;
    for (const candidate of renderedSources) {
        if (normalizeInteger(candidate.sourceIndex) === null) continue;
        if (!sourceMatchesEntry(candidate, entry)) continue;
        const specificity = candidate.messages.length;
        if (specificity < bestSpecificity) {
            best = candidate;
            bestSpecificity = specificity;
        }
    }
    return best;
}

export function deriveTranscriptNavigationRuntimeAnchors(params: Readonly<{
    entries: readonly TranscriptNavigationEntry[];
    renderedSources: readonly TranscriptNavigationRenderedAnchorSource[];
}>): TranscriptNavigationRuntimeAnchor[] {
    const anchors: TranscriptNavigationRuntimeAnchor[] = [];
    const seen = new Set<string>();
    for (const entry of params.entries) {
        const id = normalizeString(entry.id);
        if (!id || seen.has(id)) continue;
        const source = resolveMostSpecificSourceForEntry(params.renderedSources, entry);
        if (!source) continue;
        anchors.push({
            id,
            kind: entry.kind,
            sourceIndex: normalizeInteger(source.sourceIndex) ?? 0,
            messageIds: dedupeStrings(source.messageIds),
        });
        seen.add(id);
    }
    return anchors;
}
