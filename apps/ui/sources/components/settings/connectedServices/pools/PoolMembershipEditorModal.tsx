import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { layout } from '@/components/ui/layout/layout';
import {
    SelectionList,
    type SelectionListOption,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

/** A profile eligible for pool membership. */
export type PoolMembershipCandidate = Readonly<{
    profileId: string;
    title: string;
    subtitle?: string;
}>;

export type PoolMembershipEditorModalProps = CustomModalInjectedProps & Readonly<{
    candidates: ReadonlyArray<PoolMembershipCandidate>;
    initialSelectedProfileIds: ReadonlyArray<string>;
    /** Receives the target membership (profile ids) in candidate order on confirm. */
    onSubmit: (nextSelectedProfileIds: ReadonlyArray<string>) => void;
}>;

const MEMBERSHIP_LIST_MAX_HEIGHT = 380;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    subtitleRow: {
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 12,
    },
    subtitle: {
        ...Typography.default('regular'),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
}));

function PoolMembershipCheckmark() {
    const { theme } = useUnistyles();
    return <Icon name="check" size={20} color={theme.colors.accent.blue} />;
}

export function PoolMembershipEditorModal(props: PoolMembershipEditorModalProps) {
    const styles = stylesheet;

    const [selected, setSelected] = React.useState<ReadonlySet<string>>(
        () => new Set(props.initialSelectedProfileIds),
    );

    const toggle = React.useCallback((profileId: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(profileId)) next.delete(profileId);
            else next.add(profileId);
            return next;
        });
    }, []);

    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'pool-membership',
        inputPlaceholder: t('connectedServices.detail.groupActions.searchMembersPlaceholder'),
        sections: [
            {
                kind: 'static',
                id: 'candidates',
                options: props.candidates.map((candidate): SelectionListOption => ({
                    id: candidate.profileId,
                    testID: `pool-membership-editor:option:${candidate.profileId}`,
                    label: candidate.title,
                    subtitle: candidate.subtitle,
                    accessibilityLabel: candidate.title,
                    rightAccessory: selected.has(candidate.profileId)
                        ? <PoolMembershipCheckmark />
                        : undefined,
                })),
            },
        ],
    }), [props.candidates, selected]);

    const handleSelect = React.useCallback((id: string) => {
        toggle(id);
    }, [toggle]);

    const handleConfirm = React.useCallback(() => {
        // Preserve candidate order so the resulting membership is deterministic.
        const nextSelectedProfileIds = props.candidates
            .map((candidate) => candidate.profileId)
            .filter((profileId) => selected.has(profileId));
        props.onSubmit(nextSelectedProfileIds);
        props.onClose();
    }, [props, selected]);

    return (
        <View style={styles.container}>
            <View style={styles.subtitleRow}>
                <Text style={styles.subtitle} testID="pool-membership-editor:summary">
                    {t('connectedServices.detail.groupDetail.membersSubtitle', {
                        enabled: selected.size,
                        total: props.candidates.length,
                    })}
                </Text>
            </View>
            <SelectionList
                testID="pool-membership-editor:list"
                rootStep={rootStep}
                onSelect={handleSelect}
                onRequestClose={props.onClose}
                maxHeight={MEMBERSHIP_LIST_MAX_HEIGHT}
                heightBehavior="content"
            />
            <ItemGroup>
                <Item
                    testID="pool-membership-editor:cancel"
                    title={t('common.cancel')}
                    onPress={props.onClose}
                    showChevron={false}
                />
                <Item
                    testID="pool-membership-editor:confirm"
                    title={t('common.save')}
                    onPress={handleConfirm}
                    showChevron={false}
                />
            </ItemGroup>
        </View>
    );
}
