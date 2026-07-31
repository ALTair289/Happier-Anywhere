import * as React from 'react';
import { Pressable } from 'react-native';

import { hapticsLight } from '@/components/ui/theme/haptics';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';


export function createAuggieAllowIndexingChip(opts: Readonly<{
    allowIndexing: boolean;
    setAllowIndexing: (next: boolean) => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'auggie-allow-indexing',
        controlId: 'providerOption',
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'auggie-allow-indexing',
            label: t(opts.allowIndexing ? 'agentInput.auggieIndexingChip.on' : 'agentInput.auggieIndexingChip.off'),
            icon: <Icon name="magnifying-glass" size={16} color={tint} />,
            onPress: () => {
                dismiss();
                hapticsLight();
                opts.setAllowIndexing(!opts.allowIndexing);
            },
        }),
        render: ({ chipStyle, showLabel, iconColor, textStyle }) => (
            <Pressable
                onPress={() => {
                    hapticsLight();
                    opts.setAllowIndexing(!opts.allowIndexing);
                }}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(p) => chipStyle(p.pressed)}
            >
                <Icon name="magnifying-glass" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />
                {showLabel ? (
                    <Text style={textStyle}>
                        {t(opts.allowIndexing ? 'agentInput.auggieIndexingChip.on' : 'agentInput.auggieIndexingChip.off')}
                    </Text>
                ) : null}
            </Pressable>
        ),
    };
}
