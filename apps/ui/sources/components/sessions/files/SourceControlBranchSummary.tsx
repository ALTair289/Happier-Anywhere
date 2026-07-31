import * as React from 'react';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmStatusFiles } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { Icon } from '@/components/ui/icons/Icon';

const SourceControlBranchMenuLazy = React.lazy(async () => {
    const mod = await import('@/components/sessions/sourceControl/branches/SourceControlBranchMenu');
    return { default: mod.SourceControlBranchMenu };
});

type SourceControlBranchSummaryProps = {
    theme: any;
    scmStatusFiles: ScmStatusFiles;
    variant?: 'screen' | 'rail';
    sessionId?: string;
    scmSnapshot?: ScmWorkingSnapshot | null;
    scmWriteEnabled?: boolean;
    disabled?: boolean;
};

function readThemeToken(theme: any, path: readonly string[]): unknown {
    let value = theme;
    for (const segment of path) {
        if (value == null || typeof value !== 'object') return undefined;
        value = value[segment];
    }
    return value;
}

function areBranchSummaryThemeTokensEqual(previous: any, next: any): boolean {
    const tokenPaths: readonly (readonly string[])[] = [
        ['colors', 'border', 'default'],
        ['colors', 'input', 'background'],
        ['colors', 'surface', 'base'],
        ['colors', 'surface', 'inset'],
        ['colors', 'text', 'primary'],
        ['colors', 'text', 'secondary'],
    ];
    return tokenPaths.every((path) => Object.is(readThemeToken(previous, path), readThemeToken(next, path)));
}

function normalizeSummaryNumber(value: unknown): number {
    return Number(value ?? 0);
}

function areScmStatusFileSummariesEqual(previous: ScmStatusFiles, next: ScmStatusFiles): boolean {
    return previous.branch === next.branch
        && (previous.upstream ?? null) === (next.upstream ?? null)
        && normalizeSummaryNumber(previous.ahead) === normalizeSummaryNumber(next.ahead)
        && normalizeSummaryNumber(previous.behind) === normalizeSummaryNumber(next.behind)
        && normalizeSummaryNumber(previous.totalIncluded) === normalizeSummaryNumber(next.totalIncluded)
        && normalizeSummaryNumber(previous.totalPending) === normalizeSummaryNumber(next.totalPending)
        && (previous.changeSetModel ?? null) === (next.changeSetModel ?? null);
}

function areSourceControlBranchSummaryPropsEqual(
    previous: SourceControlBranchSummaryProps,
    next: SourceControlBranchSummaryProps,
): boolean {
    return previous.variant === next.variant
        && previous.sessionId === next.sessionId
        && previous.scmSnapshot === next.scmSnapshot
        && previous.scmWriteEnabled === next.scmWriteEnabled
        && previous.disabled === next.disabled
        && areBranchSummaryThemeTokensEqual(previous.theme, next.theme)
        && areScmStatusFileSummariesEqual(previous.scmStatusFiles, next.scmStatusFiles);
}

function SourceControlBranchSummaryImpl({
    theme,
    scmStatusFiles,
    variant = 'screen',
    sessionId,
    scmSnapshot,
    scmWriteEnabled,
    disabled,
}: SourceControlBranchSummaryProps) {
    const ahead = Number(scmStatusFiles.ahead ?? 0);
    const behind = Number(scmStatusFiles.behind ?? 0);
    const showTracking = Boolean(scmStatusFiles.upstream) || ahead > 0 || behind > 0;
    const staged = Number(scmStatusFiles.totalIncluded ?? 0);
    const unstaged = Number(scmStatusFiles.totalPending ?? 0);
    const usesWorkingCopyModel = scmStatusFiles.changeSetModel === 'working-copy';
    const includedLabel = usesWorkingCopyModel ? t('files.branchSummary.included') : t('files.branchSummary.staged');
    const pendingLabel = usesWorkingCopyModel ? t('files.branchSummary.pending') : t('files.branchSummary.unstaged');

    const StatPill = ({ label, value, iconName }: { label: string; value: number; iconName: string }) => {
        return (
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: theme.colors.border.default,
                    backgroundColor: theme.colors.surface.inset ?? theme.colors.input.background,
                }}
            >
                <Icon name={iconName as any} size={14} color={theme.colors.text.secondary} />
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                    {label}
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.text.primary, ...Typography.mono('semiBold') }}>
                    {String(value)}
                </Text>
            </View>
        );
    };

    const InlineStat = ({ value, iconName }: { value: number; iconName: string }) => {
        return (
            <View
                style={{
                    minWidth: 16,
                    minHeight: 30,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1,
                    flexShrink: 0,
                }}
            >
                <Text
                    numberOfLines={1}
                    style={{
                        fontSize: 11,
                        lineHeight: 13,
                        color: theme.colors.text.primary,
                        ...Typography.mono('semiBold'),
                    }}
                >
                    {String(value)}
                </Text>
                <Icon name={iconName as any} size={14} color={theme.colors.text.secondary} />
            </View>
        );
    };

    const isRail = variant === 'rail';
    const canShowBranchMenu =
        isRail
        && Boolean(sessionId)
        && scmSnapshot?.capabilities?.readBranches === true;

    if (variant === 'rail') {
        return (
            <View
                style={{
                    paddingHorizontal: 12,
                    paddingTop: 12,
                    paddingBottom: 10,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.border.default,
                    backgroundColor: theme.colors.surface.base,
                    gap: 6,
                }}
            >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <View style={{ minWidth: 0, flex: 1, gap: 4 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <Icon
                                name="git-branch"
                                size={14}
                                color={theme.colors.text.secondary}
                                style={{ flexShrink: 0 }}
                            />
                            {canShowBranchMenu && sessionId ? (
                                <React.Suspense
                                    fallback={(
                                        <Text
                                            numberOfLines={1}
                                            style={{
                                                flexShrink: 1,
                                                minWidth: 0,
                                                fontSize: 14,
                                                color: theme.colors.text.primary,
                                                ...Typography.default('semiBold'),
                                            }}
                                        >
                                            {scmStatusFiles.branch || t('files.detachedHead')}
                                        </Text>
                                    )}
                                >
                                    <SourceControlBranchMenuLazy
                                        sessionId={sessionId}
                                        currentBranch={scmStatusFiles.branch}
                                        snapshot={scmSnapshot ?? null}
                                        writeEnabled={scmWriteEnabled}
                                        disabled={disabled === true}
                                        testID="scm-branch-menu-trigger"
                                    />
                                </React.Suspense>
                            ) : (
                                <Text
                                    numberOfLines={1}
                                    style={{
                                        flexShrink: 1,
                                        minWidth: 0,
                                        fontSize: 14,
                                        color: theme.colors.text.primary,
                                        ...Typography.default('semiBold'),
                                    }}
                                >
                                    {scmStatusFiles.branch || t('files.detachedHead')}
                                </Text>
                            )}
                        </View>

                        {showTracking ? (
                            <Text
                                numberOfLines={1}
                                style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}
                            >
                                {scmStatusFiles.upstream
                                    ? t('files.branchSummary.upstreamLabel', { upstream: scmStatusFiles.upstream })
                                    : t('files.branchSummary.noUpstream')}
                            </Text>
                        ) : null}
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 5, flexShrink: 0 }}>
                        <InlineStat value={staged} iconName="plus-square" />
                        <InlineStat value={unstaged} iconName="pencil-simple" />
                        {showTracking ? <InlineStat value={ahead} iconName="arrow-up" /> : null}
                        {showTracking ? <InlineStat value={behind} iconName="arrow-down" /> : null}
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View
            style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.border.default,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 8,
                }}
            >
                <Icon name="git-branch" size={16} color={theme.colors.text.secondary} style={{ marginRight: 6 }} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.text.primary,
                        ...Typography.default('semiBold'),
                    }}
                >
                    {scmStatusFiles.branch || t('files.detachedHead')}
                </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <StatPill label={includedLabel} value={staged} iconName="plus-square" />
                <StatPill label={pendingLabel} value={unstaged} iconName="pencil-simple" />
                {showTracking && (
                    <StatPill label={t('files.branchSummary.ahead')} value={ahead} iconName="arrow-up" />
                )}
                {showTracking && (
                    <StatPill label={t('files.branchSummary.behind')} value={behind} iconName="arrow-down" />
                )}
            </View>

            {showTracking && (
                <Text
                    style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: theme.colors.text.secondary,
                        ...Typography.default(),
                    }}
                >
                    {scmStatusFiles.upstream
                        ? t('files.branchSummary.upstreamLabel', { upstream: scmStatusFiles.upstream })
                        : t('files.branchSummary.noUpstream')}
                </Text>
            )}
        </View>
    );
}

export const SourceControlBranchSummary = React.memo(
    SourceControlBranchSummaryImpl,
    areSourceControlBranchSummaryPropsEqual,
);
SourceControlBranchSummary.displayName = 'SourceControlBranchSummary';
