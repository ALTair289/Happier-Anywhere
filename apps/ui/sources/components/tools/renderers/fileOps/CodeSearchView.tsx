import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { coerceToolResultRecord } from '../../legacy/coerceToolResultRecord';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

type SearchMatch = { filePath?: string; line?: number; excerpt?: string };

function getMatches(result: unknown): SearchMatch[] {
    const record = coerceToolResultRecord(result);
    const matches = record?.matches;
    if (!Array.isArray(matches)) return [];

    const out: SearchMatch[] = [];
    for (const item of matches) {
        const obj = asRecord(item);
        if (!obj) continue;
        out.push({
            filePath: typeof obj.filePath === 'string' ? obj.filePath : undefined,
            line: typeof obj.line === 'number' ? obj.line : undefined,
            excerpt: typeof obj.excerpt === 'string' ? obj.excerpt : undefined,
        });
    }
    return out;
}

function readSearchSummary(result: unknown): Readonly<{
    totalMatches: number | null;
    totalFiles: number | null;
    detailsUnavailable: boolean;
    truncated: boolean;
}> {
    const record = coerceToolResultRecord(result);
    const readCount = (value: unknown): number | null => (
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
    );
    return {
        totalMatches: readCount(record?.totalMatches),
        totalFiles: readCount(record?.totalFiles),
        detailsUnavailable: record?.detailsUnavailable === true,
        truncated: record?.truncated === true,
    };
}

export const CodeSearchView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (tool.state !== 'completed') return null;
    const matches = getMatches(tool.result);
    const summary = readSearchSummary(tool.result);
    const aggregateCounts = [summary.totalMatches, summary.totalFiles]
        .filter((count): count is number => count !== null);
    const isExplicitZero = matches.length === 0
        && aggregateCounts.length > 0
        && aggregateCounts.every((count) => count === 0);
    // Truncation alone is not evidence that a search completed or found results.
    if (matches.length === 0 && !summary.detailsUnavailable && !isExplicitZero) return null;

    const isFullView = detailLevel === 'full';
    const shown = matches.slice(0, isFullView ? 20 : 6);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {summary.detailsUnavailable ? (
                    <Text style={styles.summary}>
                        {summary.totalMatches !== null
                            ? summary.totalMatches === 1
                                ? t('tools.codeSearch.aggregateMatchUnavailable')
                                : t('tools.codeSearch.aggregateMatchesUnavailable', { count: summary.totalMatches })
                            : summary.totalFiles !== null
                                ? t('tools.codeSearch.aggregateFilesUnavailable', { count: summary.totalFiles })
                                : t('tools.codeSearch.detailsUnavailable')}
                    </Text>
                ) : null}
                {isExplicitZero ? <Text style={styles.summary}>{t('common.noMatches')}</Text> : null}
                {shown.map((m, idx) => {
                    const label = m.filePath
                        ? `${m.filePath}${typeof m.line === 'number' ? `:${m.line}` : ''}`
                        : null;
                    return (
                        <View key={idx} style={styles.row}>
                            {label ? <Text style={styles.label} numberOfLines={isFullView ? 2 : 1}>{label}</Text> : null}
                            {m.excerpt ? <Text style={styles.text} numberOfLines={isFullView ? 6 : 2}>{m.excerpt}</Text> : null}
                        </View>
                    );
                })}
                {more > 0 ? <Text style={styles.more}>{t('tools.structuredResult.more', { count: more })}</Text> : null}
                {summary.truncated ? <Text style={styles.more}>{t('tools.codeSearch.truncated')}</Text> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 10,
    },
    row: {
        gap: 4,
    },
    summary: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    text: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontFamily: 'Menlo',
    },
    more: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));
