import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';

export type GitSubTabId = 'commit' | 'update' | 'history';

export type SessionRightPanelGitSubTabsBarProps = Readonly<{
    tabs: ReadonlyArray<{ id: GitSubTabId; label: string }>;
    activeSubTabId: GitSubTabId;
    onSelectSubTab: (subTabId: GitSubTabId) => void;
}>;

/**
 * This used to be a bespoke segmented control: its own bordered track, its own typography, and an
 * active state that was the INVERSE of the canonical one (active tab = inset fill on a base track,
 * where SegmentedTabBar uses a raised thumb on an inset track). Two controls that look like the same
 * thing but invert their own selection semantics is the kind of split-brain that makes a product
 * feel inconsistent without any single screen looking wrong.
 *
 * It is now a thin arrangement over the canonical `SegmentedTabBar`. The testID contract is
 * unchanged — SegmentedTabBar emits `${testIDPrefix}:${tab.id}`, which is exactly the format the
 * previous implementation built by hand.
 */

const SUB_TAB_TEST_ID_PREFIX = 'session-rightpanel-git-subtab';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 10,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
}));

export const SessionRightPanelGitSubTabsBar = React.memo((props: SessionRightPanelGitSubTabsBarProps) => {
    const styles = stylesheet;

    const tabs = React.useMemo(
        (): ReadonlyArray<SegmentedTab<GitSubTabId>> =>
            props.tabs.map((tab) => ({ id: tab.id, label: tab.label })),
        [props.tabs],
    );

    return (
        <View style={styles.container}>
            <SegmentedTabBar
                tabs={tabs}
                activeTabId={props.activeSubTabId}
                onSelectTab={props.onSelectSubTab}
                testIDPrefix={SUB_TAB_TEST_ID_PREFIX}
            />
        </View>
    );
});
