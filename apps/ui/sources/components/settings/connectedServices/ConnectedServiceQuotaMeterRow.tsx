import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { clampQuotaPct, deriveQuotaUtilizationPct } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';
import { formatResetCountdown, type ResetCountdownFormatter } from '@/sync/domains/connectedServices/formatResetCountdown';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { t } from '@/text';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const RESET_COUNTDOWN_FORMATTER: ResetCountdownFormatter = {
  durationNow: () => t('connectedServices.quota.duration.now'),
  durationOutdated: () => t('connectedServices.quota.duration.outdated'),
  durationDaysHours: ({ days, hours }) => t('connectedServices.quota.duration.daysHours', { days, hours }),
  durationHoursMinutes: ({ hours, minutes }) => t('connectedServices.quota.duration.hoursMinutes', { hours, minutes }),
  durationHours: ({ hours }) => t('connectedServices.quota.duration.hours', { hours }),
  durationMinutes: ({ minutes }) => t('connectedServices.quota.duration.minutes', { minutes }),
};

const stylesheet = StyleSheet.create((theme) => ({
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  bar: {
    flex: 1,
  },
  subtitleText: {
    ...Typography.rowMeta(),
    color: theme.colors.text.secondary,
  },
  rightText: {
    minWidth: 74,
    textAlign: 'right',
    ...Typography.rowMeta(),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
  },
}));

export const ConnectedServiceQuotaMeterRow = React.memo(function ConnectedServiceQuotaMeterRow(props: Readonly<{
  meter: ConnectedServiceQuotaMeterV1;
  nowMs: number;
  pinned: boolean;
  onTogglePin: () => void;
}>) {
  const { theme } = useUnistyles();
  const styles = stylesheet;

  const utilization = deriveQuotaUtilizationPct(props.meter);
  const remaining = typeof props.meter.remainingPct === 'number' && Number.isFinite(props.meter.remainingPct)
    ? clampQuotaPct(props.meter.remainingPct)
    : utilization === null ? null : clampQuotaPct(100 - utilization);
  const remainingText = remaining === null ? '—' : `${Math.round(remaining)}%`;
  const resetText = formatResetCountdown(props.nowMs, props.meter.resetAtMs ?? props.meter.resetsAt, RESET_COUNTDOWN_FORMATTER);
  const right = remaining === null
    ? remainingText
    : resetText
    ? t('connectedServices.quota.remainingWithReset', { percent: remainingText, reset: resetText })
    : t('connectedServices.quota.remaining', { percent: remainingText });
  const tone = resolveQuotaTone(remaining);

  const usageText =
    typeof props.meter.used === 'number' && typeof props.meter.limit === 'number'
      ? t('connectedServices.quota.usageCount', { used: props.meter.used, limit: props.meter.limit })
      : null;

  const subtitle = (
    <View>
      <View style={styles.subtitleRow}>
        <MeterBar
          testID="connected-service-quota-meter-row:remaining-bar"
          style={styles.bar}
          tone={tone}
          fillFraction={(remaining ?? 0) / 100}
        />
        <Text style={styles.rightText}>{right}</Text>
      </View>
      {usageText ? <Text style={styles.subtitleText}>{usageText}</Text> : null}
    </View>
  );

  const pinIcon = props.pinned ? 'bookmark' : 'bookmark-outline';

  return (
    <Item
      title={props.meter.label}
      subtitle={subtitle}
      subtitleLines={0}
      showChevron={false}
      rightElement={(
        <Pressable onPress={props.onTogglePin} hitSlop={12} style={{ paddingLeft: 8, paddingVertical: 4 }}>
          <Ionicons name={pinIcon as IoniconName} size={18} color={props.pinned ? theme.colors.text.primary : theme.colors.text.secondary} />
        </Pressable>
      )}
    />
  );
});
