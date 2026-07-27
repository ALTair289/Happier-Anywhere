import React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    deriveTranscriptInteraction,
    type TranscriptInteraction,
} from '@/utils/sessions/deriveTranscriptInteraction';

import { parseHappierMetaEnvelope } from './happierMetaEnvelope';
import { findStructuredMessageRenderer, type StructuredMessageRendererParams } from './structuredMessageRegistry';

const FAIL_CLOSED_STRUCTURED_MESSAGE_INTERACTION = deriveTranscriptInteraction({ kind: 'public' });

export function renderStructuredMessage(params: {
    message: Message;
    sessionId: string;
    interaction: TranscriptInteraction;
    onJumpToAnchor?: StructuredMessageRendererParams['onJumpToAnchor'];
}): React.ReactElement | null {
    const envelope = parseHappierMetaEnvelope(params.message.meta);
    if (!envelope) return null;

    const entry = findStructuredMessageRenderer(envelope.kind);
    if (!entry) return null;

    const parsed = entry.schema.safeParse(envelope.payload);
    if (!parsed.success) return null;

    return entry.render(parsed.data, {
        sessionId: params.sessionId,
        message: params.message,
        interaction: params.interaction,
        onJumpToAnchor: params.onJumpToAnchor,
    });
}

export const StructuredMessageBlock = React.memo(function StructuredMessageBlock(props: {
    message: Message;
    sessionId: string;
    interaction?: TranscriptInteraction;
    onJumpToAnchor?: StructuredMessageRendererParams['onJumpToAnchor'];
}): React.ReactElement | null {
    return renderStructuredMessage({
        ...props,
        interaction: props.interaction ?? FAIL_CLOSED_STRUCTURED_MESSAGE_INTERACTION,
    });
});
