import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export type WorkflowAgentDetailProps = Readonly<{
    text: string;
    detailTestID?: string;
}>;

/**
 * Focused agent-detail preview shared by workflow rows in the popover and transcript card.
 * The full provider-specific payload is normalized before it reaches this component; this renderer
 * only owns the detail surface treatment.
 */
export const WorkflowAgentDetail = React.memo<WorkflowAgentDetailProps>((props) => (
    <View style={styles.container} testID={props.detailTestID}>
        <Text style={styles.text}>{props.text}</Text>
    </View>
));
WorkflowAgentDetail.displayName = 'WorkflowAgentDetail';

const styles = StyleSheet.create((theme) => ({
    container: {
        marginLeft: 26,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    text: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
}));
