import * as React from 'react';
import { Platform, View } from 'react-native';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { ChatFooter } from '@/components/sessions/transcript/ChatFooter';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    TRANSCRIPT_TOP_GUTTER_PX,
} from '@/components/sessions/transcript/_constants';
import { useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';
import { useOptionalTranscriptSelectionState } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { TranscriptListShell } from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveReadOnlyTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

export type TranscriptBottomNotice = {
    title: string;
    body: string;
};

const ListHeader = React.memo((props: { isLoading?: boolean }) => {
    return (
        <View>
            {props.isLoading ? (
                <View style={{ paddingVertical: 12 }}>
                    <ActivitySpinner size="small" />
                </View>
            ) : null}
            <View style={{ height: TRANSCRIPT_TOP_GUTTER_PX }} />
        </View>
    );
});

const ListFooter = React.memo((props: { bottomNotice?: TranscriptBottomNotice | null }) => {
    return <ChatFooter notice={props.bottomNotice ?? null} controlledByUser={false} />;
});

const PUBLIC_READ_ONLY_TRANSCRIPT_INTERACTION = deriveTranscriptInteraction({
    kind: 'public',
    disableToolNavigation: true,
});

export const TranscriptList = React.memo((props: {
    sessionId: string;
    metadata: Metadata | null;
    messages: Message[];
    bottomNotice?: TranscriptBottomNotice | null;
    isLoaded?: boolean;
}) => {
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const sessionThinkingDisplayMode = transcriptSessionCommon.messageDisplay.sessionThinkingDisplayMode;
    const sessionThinkingInlinePresentation = transcriptSessionCommon.messageDisplay.sessionThinkingInlinePresentation;
    const shellFrame = React.useMemo(() => resolveReadOnlyTranscriptListShellFrame({
        accessKind: 'public',
        bottomNoticeVisible: props.bottomNotice != null,
        platformOS: Platform.OS,
    }), [props.bottomNotice]);
    const listData = React.useMemo(() => {
        if (shellFrame.dataOrder === 'newest-first') {
            // Inverted lists expect newest-first input.
            return [...props.messages].reverse();
        }
        return props.messages;
    }, [props.messages, shellFrame.dataOrder]);

    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
        () => new Map<string, boolean>(),
    );
    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);
    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        setThinkingExpandedByMessageId((prev) => {
            const prevValue = prev.get(messageId);
            if (prevValue === expanded) return prev;
            const next = new Map(prev);
            if (expanded === thinkingDefaultExpanded) {
                next.delete(messageId);
            } else {
                next.set(messageId, expanded);
            }
            return next;
        });
    }, [thinkingDefaultExpanded]);

    const keyExtractor = React.useCallback((item: Message) => item.id, []);
    const getItemType = React.useCallback((item: Message): string => item.kind, []);
    const renderItem = React.useCallback(({ item }: { item: Message }) => {
        const controlledThinking =
            item.kind === 'agent-text' &&
            item.isThinking === true &&
            sessionThinkingDisplayMode === 'inline';
        return (
            <MessageViewWithSessionCommon
                message={item}
                metadata={props.metadata}
                sessionId={props.sessionId}
                interaction={PUBLIC_READ_ONLY_TRANSCRIPT_INTERACTION}
                forkCommon={transcriptSessionCommon.fork}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                toolRouteCommon={transcriptSessionCommon.toolRoute}
                thinkingExpanded={controlledThinking ? resolveThinkingExpanded(item.id) : undefined}
                onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(item.id, next) : undefined}
            />
        );
    }, [
        props.metadata,
        props.sessionId,
        resolveThinkingExpanded,
        sessionThinkingDisplayMode,
        setThinkingExpanded,
        transcriptSessionCommon.fork,
        transcriptSessionCommon.messageDisplay,
        transcriptSessionCommon.toolChrome,
        transcriptSessionCommon.toolRoute,
    ]);

    return (
        <TranscriptListShell<Message>
            data={listData}
            extraData={transcriptMessageSelection.selectionVersion}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            frame={shellFrame}
            header={<ListHeader isLoading={props.isLoaded === false} />}
            footer={<ListFooter bottomNotice={props.bottomNotice ?? null} />}
        />
    );
});
