import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { deriveCanonicalPatchFileDiffs } from '@happier-dev/protocol/tools/v2';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { resolvePath } from '@/utils/path/pathUtils';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import { buildDiffFileEntries, type DiffBlockInput, type DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { ToolFileDiffListView } from './ToolFileDiffListView';
import { Icon } from '@/components/ui/icons/Icon';


function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function extractDiffBlocksFromResult(result: unknown): DiffBlockInput[] {
    const obj = asRecord(result);
    const metadata = asRecord(obj?.metadata);
    const files = Array.isArray(metadata?.files) ? (metadata?.files as unknown[]) : null;
    if (!files) return [];

    const out: DiffBlockInput[] = [];
    for (const raw of files) {
        const file = asRecord(raw);
        if (!file) continue;
        const relativePath = firstNonEmptyString(file.relativePath);
        const absolutePath = firstNonEmptyString(file.filePath);
        const filePath = relativePath ?? absolutePath;
        if (!filePath) continue;

        const before = typeof file.before === 'string' ? file.before : '';
        const after = typeof file.after === 'string' ? file.after : '';
        if (!before && !after) continue;

        out.push({ filePath, oldText: before, newText: after });
    }

    return out;
}

function extractDiffBlocksFromInput(input: unknown): DiffBlockInput[] {
    return deriveCanonicalPatchFileDiffs(input).map((file) => ({
        filePath: file.filePath,
        ...(typeof file.unifiedDiff === 'string'
            ? { unifiedDiff: file.unifiedDiff }
            : {
                oldText: file.oldText ?? '',
                newText: file.newText ?? '',
            }),
    }));
}

function buildPatchDiffEntries(input: unknown, result: unknown): DiffFileEntry[] {
    const resultBlocks = extractDiffBlocksFromResult(result);
    const blocks = resultBlocks.length > 0 ? resultBlocks : extractDiffBlocksFromInput(input);
    return buildDiffFileEntries(blocks);
}

function extractFilePaths(input: unknown): string[] {
    const obj = asRecord(input);
    const changes = obj?.changes;
    if (Array.isArray(changes)) {
        return changes.flatMap((rawChange) => {
            const change = asRecord(rawChange);
            const path = firstNonEmptyString(change?.path) ?? firstNonEmptyString(change?.filePath);
            return path ? [path] : [];
        });
    }

    const changesRecord = asRecord(changes);
    return changesRecord ? Object.keys(changesRecord) : [];
}

function extractErrorMessage(result: unknown): string | null {
    if (!result) return null;
    if (typeof result === 'string') return firstNonEmptyString(result);
    const obj = asRecord(result);
    if (!obj) return null;

    return (
        firstNonEmptyString(obj.errorMessage) ??
        firstNonEmptyString(obj.error) ??
        firstNonEmptyString(obj.message) ??
        null
    );
}

export const PatchView = React.memo<ToolViewProps>(({ tool, metadata, detailLevel, sessionId }) => {
    const { theme } = useUnistyles();
    const { input } = tool;
    const errorMessage = tool.state === 'error' ? extractErrorMessage(tool.result) : null;

    const files = extractFilePaths(input);
    const diffFiles = React.useMemo(() => buildPatchDiffEntries(tool.input, tool.result), [tool.input, tool.result]);
    const allDeletes =
        input?.changes &&
        typeof input.changes === 'object' &&
        files.length > 0 &&
        Object.values(input.changes as any).every((change) => {
            if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
            const type = typeof (change as any).type === 'string' ? String((change as any).type).toLowerCase() : null;
            return type === 'delete' || (change as any).delete != null;
        });

    const applied = !!(
        tool.result &&
        typeof tool.result === 'object' &&
        !Array.isArray(tool.result) &&
        (tool.result as any).applied === true
    );

    if (files.length === 0) {
        if (errorMessage) {
            return (
                <ToolSectionView>
                    <ToolError message={errorMessage} />
                </ToolSectionView>
            );
        }
        return null;
    }

    if (diffFiles.length > 0) {
        return (
            <ToolSectionView fullWidth>
                {errorMessage ? <ToolError message={errorMessage} /> : null}
                {allDeletes || applied ? (
                    <View style={styles.statusRow}>
                        {allDeletes ? <Text style={styles.applied}>{t('common.deleted')}</Text> : null}
                        {applied ? <Text style={styles.applied}>{t('common.applied')}</Text> : null}
                    </View>
                ) : null}
                <ToolFileDiffListView
                    files={diffFiles}
                    detailLevel={detailLevel}
                    sessionId={sessionId}
                />
            </ToolSectionView>
        );
    }

    if (files.length === 1) {
        const filePath = resolvePath(files[0], metadata);
        const fileName = filePath.split('/').pop() || filePath;

        return (
            <ToolSectionView>
                {errorMessage ? <ToolError message={errorMessage} /> : null}
                <View style={styles.fileContainer}>
                    <Icon name="git-diff" size={16} color={theme.colors.text.secondary} />
                    <Text style={styles.fileName}>{fileName}</Text>
                    {allDeletes ? <Text style={styles.applied}>{t('common.deleted')}</Text> : null}
                    {applied ? <Text style={styles.applied}>{t('common.applied')}</Text> : null}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            {errorMessage ? <ToolError message={errorMessage} /> : null}
            <View style={styles.filesContainer}>
                {allDeletes ? <Text style={styles.applied}>{t('common.deleted')}</Text> : null}
                {applied ? <Text style={styles.applied}>{t('common.applied')}</Text> : null}
                {files.map((file, index) => {
                    const filePath = resolvePath(file, metadata);
                    const fileName = filePath.split('/').pop() || filePath;

                    return (
                        <View key={index} style={styles.fileRow}>
                            <Icon name="git-diff" size={14} color={theme.colors.text.secondary} />
                            <Text style={styles.fileNameMulti}>{fileName}</Text>
                        </View>
                    );
                })}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    statusRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        marginBottom: 8,
    },
    fileContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 8,
    },
    filesContainer: {
        padding: 12,
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 8,
        gap: 8,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    fileName: {
        fontSize: 14,
        color: theme.colors.text.primary,
        fontWeight: '500',
    },
    fileNameMulti: {
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    applied: {
        marginLeft: 'auto',
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));
