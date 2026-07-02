import { structuredPatch } from 'diff';

import { buildPlaceholderUnifiedDiff } from './derivePendingNormalizedToolChange';

/**
 * CPU guards for local diff computation on oversized files. Whichever trips first aborts the
 * diff and degrades the file to a truncated placeholder.
 */
const DIFF_MAX_EDIT_LENGTH = 10_000;
const DIFF_TIMEOUT_MS = 1_000;
const DIFF_CONTEXT_LINES = 3;

export type TurnDiffFileEntry = Readonly<{
    file_path: string;
    unified_diff?: string;
    oldText?: string;
    newText?: string;
    description?: string;
}>;

export type TurnDiffFileStats = Readonly<{
    oldTextBytes?: number;
    newTextBytes?: number;
    unifiedDiffBytes?: number;
    addedLines?: number;
    removedLines?: number;
}>;

export type BoundedTurnDiffFileEntry = TurnDiffFileEntry & Readonly<{
    truncated?: true;
    stats?: TurnDiffFileStats;
}>;

export type BoundTurnDiffFilesResult = Readonly<{
    files: BoundedTurnDiffFileEntry[];
    truncatedFileCount: number;
}>;

function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

function countUnifiedDiffChangedLines(unifiedDiff: string): Readonly<{ addedLines: number; removedLines: number }> {
    let addedLines = 0;
    let removedLines = 0;
    for (const line of unifiedDiff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) addedLines += 1;
        else if (line.startsWith('-') && !line.startsWith('---')) removedLines += 1;
    }
    return { addedLines, removedLines };
}

function computeBoundedUnifiedDiff(params: Readonly<{
    filePath: string;
    oldText: string;
    newText: string;
    maxBytes: number;
}>): string | null {
    let patch: ReturnType<typeof structuredPatch> | undefined;
    try {
        patch = structuredPatch(
            params.filePath,
            params.filePath,
            params.oldText,
            params.newText,
            undefined,
            undefined,
            {
                context: DIFF_CONTEXT_LINES,
                maxEditLength: DIFF_MAX_EDIT_LENGTH,
                timeout: DIFF_TIMEOUT_MS,
            },
        );
    } catch {
        return null;
    }
    if (!patch) return null;
    const lines: string[] = [
        `diff --git a/${params.filePath} b/${params.filePath}`,
        `--- a/${params.filePath}`,
        `+++ b/${params.filePath}`,
    ];
    for (const hunk of patch.hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        lines.push(...hunk.lines);
    }
    const unifiedDiff = lines.join('\n');
    if (byteLength(unifiedDiff) > params.maxBytes) return null;
    return unifiedDiff;
}

function buildTruncatedEntry(params: Readonly<{
    entry: TurnDiffFileEntry;
    stats: TurnDiffFileStats;
}>): BoundedTurnDiffFileEntry {
    return {
        file_path: params.entry.file_path,
        unified_diff: buildPlaceholderUnifiedDiff(
            params.entry.file_path,
            params.entry.description ?? 'Diff too large',
        ),
        ...(params.entry.description ? { description: params.entry.description } : {}),
        truncated: true,
        stats: params.stats,
    };
}

/**
 * Bounds the per-turn Diff tool payload at the emission choke point.
 *
 * - Small old/new text pairs (within budget) pass through untouched.
 * - Oversized text pairs are replaced with a locally computed unified diff (usually a tiny
 *   fraction of the full texts) plus byte stats for the omitted texts.
 * - Files whose diff still exceeds the budget — and every file after the per-turn budget is
 *   exhausted — degrade to a placeholder diff with `truncated: true` and stats, so clients can
 *   offer on-demand retrieval instead of receiving multi-megabyte payloads inline.
 *
 * A budget of `0` disables the corresponding bound.
 */
export function boundTurnDiffFiles(params: Readonly<{
    files: readonly TurnDiffFileEntry[];
    fileBudgetBytes: number;
    turnBudgetBytes: number;
}>): BoundTurnDiffFilesResult {
    const fileBudget = params.fileBudgetBytes > 0 ? params.fileBudgetBytes : Number.POSITIVE_INFINITY;
    let remainingTurnBudget = params.turnBudgetBytes > 0 ? params.turnBudgetBytes : Number.POSITIVE_INFINITY;

    const files: BoundedTurnDiffFileEntry[] = [];
    let truncatedFileCount = 0;

    for (const entry of params.files) {
        const allowed = Math.min(fileBudget, remainingTurnBudget);

        const hasTextPair = typeof entry.oldText === 'string' && typeof entry.newText === 'string';
        if (hasTextPair) {
            const oldTextBytes = byteLength(entry.oldText!);
            const newTextBytes = byteLength(entry.newText!);
            if (oldTextBytes + newTextBytes <= allowed) {
                files.push(entry);
                remainingTurnBudget -= oldTextBytes + newTextBytes;
                continue;
            }
            const boundedDiff = computeBoundedUnifiedDiff({
                filePath: entry.file_path,
                oldText: entry.oldText!,
                newText: entry.newText!,
                maxBytes: allowed,
            });
            if (boundedDiff !== null) {
                files.push({
                    file_path: entry.file_path,
                    unified_diff: boundedDiff,
                    ...(entry.description ? { description: entry.description } : {}),
                    stats: { oldTextBytes, newTextBytes },
                });
                remainingTurnBudget -= byteLength(boundedDiff);
                continue;
            }
            const truncatedEntry = buildTruncatedEntry({
                entry,
                stats: { oldTextBytes, newTextBytes },
            });
            files.push(truncatedEntry);
            truncatedFileCount += 1;
            remainingTurnBudget -= byteLength(truncatedEntry.unified_diff!);
            continue;
        }

        if (typeof entry.unified_diff === 'string') {
            const unifiedDiffBytes = byteLength(entry.unified_diff);
            if (unifiedDiffBytes <= allowed) {
                files.push(entry);
                remainingTurnBudget -= unifiedDiffBytes;
                continue;
            }
            const truncatedEntry = buildTruncatedEntry({
                entry,
                stats: {
                    unifiedDiffBytes,
                    ...countUnifiedDiffChangedLines(entry.unified_diff),
                },
            });
            files.push(truncatedEntry);
            truncatedFileCount += 1;
            remainingTurnBudget -= byteLength(truncatedEntry.unified_diff!);
            continue;
        }

        // No sizable content (already placeholder-shaped); pass through.
        files.push(entry);
    }

    return { files, truncatedFileCount };
}
