import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MeterBar, type MeterTone } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { TokenUsageRing, type TokenUsageTone } from '@/components/sessions/usage';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

import { AgentInputContentPopover } from './AgentInputContentPopover';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

type AgentInputProviderUsageBadgeProps = Readonly<{
    viewModel: ConnectedServiceQuotaGaugeViewModel;
    marginLeft?: number;
    onRecoveryCreditPress?: () => void;
    recoveryCreditActionPending?: boolean;
}>;

function areProviderUsageMeterRowsEqual(
    left: ConnectedServiceQuotaGaugeViewModel['allMeterRows'],
    right: ConnectedServiceQuotaGaugeViewModel['allMeterRows'],
): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        const leftRow = left[index];
        const rightRow = right[index];
        if (!leftRow || !rightRow) return false;
        if (
            leftRow.meterId !== rightRow.meterId
            || leftRow.label !== rightRow.label
            || leftRow.remainingPct !== rightRow.remainingPct
            || leftRow.usedPct !== rightRow.usedPct
            || leftRow.detailRightSemantics !== rightRow.detailRightSemantics
            || leftRow.detailRightLabel !== rightRow.detailRightLabel
            || leftRow.usedLimitSemantics !== rightRow.usedLimitSemantics
            || leftRow.usedLimitLabel !== rightRow.usedLimitLabel
            || leftRow.resetLabel !== rightRow.resetLabel
            || leftRow.tone !== rightRow.tone
        ) {
            return false;
        }
    }
    return true;
}

function areProviderUsageRecoveryCreditsEqual(
    left: ConnectedServiceQuotaGaugeViewModel['recoveryCreditSummary'],
    right: ConnectedServiceQuotaGaugeViewModel['recoveryCreditSummary'],
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.availableCount === right.availableCount
        && left.nextExpiresAtMs === right.nextExpiresAtMs
        && left.providerCreditId === right.providerCreditId;
}

function areProviderUsageViewModelsEqual(
    left: ConnectedServiceQuotaGaugeViewModel,
    right: ConnectedServiceQuotaGaugeViewModel,
): boolean {
    return left.serviceId === right.serviceId
        && left.providerDisplayName === right.providerDisplayName
        && left.activeAccountDisplayLabel === right.activeAccountDisplayLabel
        && left.remainingPct === right.remainingPct
        && left.usedPct === right.usedPct
        && left.valueLabel === right.valueLabel
        && left.ringValueLabel === right.ringValueLabel
        && left.badgeLabel === right.badgeLabel
        && left.scopePrefix === right.scopePrefix
        && left.primaryValueSemantics === right.primaryValueSemantics
        && left.detailRightLabel === right.detailRightLabel
        && left.usedLimitLabel === right.usedLimitLabel
        && left.resetLabel === right.resetLabel
        && left.tone === right.tone
        && left.isStale === right.isStale
        && areProviderUsageRecoveryCreditsEqual(left.recoveryCreditSummary, right.recoveryCreditSummary)
        && areProviderUsageMeterRowsEqual(left.allMeterRows, right.allMeterRows);
}

function areProviderUsageBadgePropsEqual(
    left: AgentInputProviderUsageBadgeProps,
    right: AgentInputProviderUsageBadgeProps,
): boolean {
    return left.marginLeft === right.marginLeft
        && left.onRecoveryCreditPress === right.onRecoveryCreditPress
        && left.recoveryCreditActionPending === right.recoveryCreditActionPending
        && areProviderUsageViewModelsEqual(left.viewModel, right.viewModel);
}

function mapQuotaToneToTokenTone(tone: ConnectedServiceQuotaGaugeViewModel['tone']): TokenUsageTone {
    if (tone === 'critical') return 'critical';
    if (tone === 'warning') return 'warning';
    return 'neutral';
}

function mapGaugeToneToMeterTone(tone: ConnectedServiceQuotaGaugeViewModel['tone']): MeterTone {
    if (tone === 'critical') return 'danger';
    if (tone === 'warning') return 'warning';
    return 'success';
}

export const AgentInputProviderUsageBadge = React.memo(function AgentInputProviderUsageBadge(
    props: AgentInputProviderUsageBadgeProps,
) {
    const styles = stylesheet;
    const anchorRef = React.useRef<any>(null);
    const [isPinnedOpen, setIsPinnedOpen] = React.useState(false);
    const [isHovered, setIsHovered] = React.useState(false);
    const open = isPinnedOpen || isHovered;
    const accessibilityLabel = t('agentInput.providerUsage.accessibilityLabel', {
        value: props.viewModel.badgeLabel,
    });
    const title = props.viewModel.providerDisplayName
        ? t('agentInput.providerUsage.titleForProvider', { provider: props.viewModel.providerDisplayName })
        : t('agentInput.providerUsage.title');
    const recoveryCreditSummary = props.viewModel.recoveryCreditSummary;

    return (
        <>
            <View testID="agent-input-provider-quota-badge">
            <Pressable
                ref={anchorRef}
                testID="agent-input-provider-usage-badge"
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                onPress={() => {
                    setIsPinnedOpen((previous) => !previous);
                }}
                onHoverIn={Platform.OS === 'web' ? () => setIsHovered(true) : undefined}
                onHoverOut={Platform.OS === 'web' ? () => setIsHovered(false) : undefined}
                style={(state) => {
                    const hovered = (state as WebHoverablePressableState).hovered === true;
                    return [
                        styles.badge,
                        { marginLeft: props.marginLeft ?? 0 },
                        (state.pressed || hovered) ? styles.badgePressed : null,
                    ];
                }}
            >
                <TokenUsageRing
                    used={props.viewModel.usedPct}
                    limit={100}
                    label={accessibilityLabel}
                    value={props.viewModel.ringValueLabel}
                    tone={mapQuotaToneToTokenTone(props.viewModel.tone)}
                    ringTestID="agent-input-provider-usage-ring"
                    valueTestID="agent-input-provider-usage-value"
                />
            </Pressable>
            </View>

            <AgentInputContentPopover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => {
                    setIsPinnedOpen(false);
                    setIsHovered(false);
                }}
                maxWidthCap={360}
                testID="agent-input-provider-usage-popover"
                scrollEnabled={false}
                content={(
                    <View style={styles.popoverContent}>
                        <Text style={styles.popoverTitle}>
                            {title}
                        </Text>
                        {props.viewModel.activeAccountDisplayLabel ? (
                            <Text style={styles.popoverAccount}>
                                {t('agentInput.providerUsage.activeAccount', { account: props.viewModel.activeAccountDisplayLabel })}
                            </Text>
                        ) : null}
                        <Text style={styles.popoverDetail}>
                            {props.viewModel.detailRightLabel}
                        </Text>
                        {props.viewModel.allMeterRows.map((row) => (
                            <View
                                key={row.meterId}
                                testID={`agent-input-provider-usage-meter:${row.meterId}`}
                                style={styles.meterRow}
                            >
                                <View style={styles.meterHeader}>
                                    <Text style={styles.meterLabel} numberOfLines={1}>
                                        {row.label}
                                    </Text>
                                    <Text style={styles.meterRight} numberOfLines={1}>
                                        {row.detailRightLabel}
                                    </Text>
                                </View>
                                <MeterBar
                                    testID={`agent-input-provider-usage-meter-bar:${row.meterId}`}
                                    tone={mapGaugeToneToMeterTone(row.tone)}
                                    fillFraction={row.usedPct / 100}
                                    height={5}
                                />
                                {row.usedLimitLabel ? (
                                    <Text style={styles.meterUsage}>
                                        {row.usedLimitLabel}
                                    </Text>
                                ) : null}
                            </View>
                        ))}
                        {recoveryCreditSummary ? (
                            <View
                                testID="agent-input-provider-usage-recovery-credit"
                                style={styles.recoveryCredit}
                            >
                                <Text style={styles.recoveryCreditTitle}>
                                    {t('connectedServices.quota.recoveryCreditTitle', { count: recoveryCreditSummary.availableCount })}
                                </Text>
                                <Text style={styles.recoveryCreditSubtitle}>
                                    {typeof recoveryCreditSummary.nextExpiresAtMs === 'number'
                                        ? t('connectedServices.quota.recoveryCreditExpires', { time: new Date(recoveryCreditSummary.nextExpiresAtMs).toLocaleString() })
                                        : t('connectedServices.quota.recoveryCreditSubtitle')}
                                </Text>
                                {props.onRecoveryCreditPress ? (
                                    <Pressable
                                        testID="agent-input-provider-usage-recovery-credit-action"
                                        accessibilityRole="button"
                                        disabled={props.recoveryCreditActionPending === true}
                                        onPress={props.onRecoveryCreditPress}
                                        style={({ pressed }) => [
                                            styles.recoveryCreditAction,
                                            pressed ? styles.recoveryCreditActionPressed : null,
                                            props.recoveryCreditActionPending === true ? styles.recoveryCreditActionDisabled : null,
                                        ]}
                                    >
                                        <Text style={styles.recoveryCreditActionText}>
                                            {props.recoveryCreditActionPending === true
                                                ? t('connectedServices.quota.recoveryCreditApplying')
                                                : t('session.usageLimitRecovery.consumeResetCreditAction')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                )}
            />
        </>
    );
}, areProviderUsageBadgePropsEqual);

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        position: 'relative',
        width: 20,
        height: 20,
        borderRadius: 999,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgePressed: {
        opacity: 0.9,
    },
    popoverContent: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
    },
    popoverTitle: {
        fontSize: 11,
        letterSpacing: 1,
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
        ...Typography.header(),
    },
    popoverDetail: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
    popoverAccount: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    meterRow: {
        gap: 6,
    },
    meterHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    meterLabel: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    meterRight: {
        flexShrink: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    meterUsage: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    recoveryCredit: {
        gap: 6,
        paddingTop: 2,
    },
    recoveryCreditTitle: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    recoveryCreditSubtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    recoveryCreditAction: {
        alignSelf: 'flex-start',
        minHeight: 28,
        justifyContent: 'center',
        borderRadius: 6,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    recoveryCreditActionPressed: {
        opacity: 0.82,
    },
    recoveryCreditActionDisabled: {
        opacity: 0.58,
    },
    recoveryCreditActionText: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));
