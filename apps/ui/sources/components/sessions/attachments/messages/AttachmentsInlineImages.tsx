import * as React from 'react';

import { SessionMediaInlineImages } from '@/components/sessions/sessionMedia/SessionMediaInlineImages';
import type { SessionMediaInlineImageSummary } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';

export type InlineImageAttachmentSummary = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
}>;

function attachmentToSessionMedia(attachment: InlineImageAttachmentSummary): SessionMediaInlineImageSummary {
    return {
        name: attachment.name,
        path: attachment.path,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        sizeBytes: attachment.sizeBytes,
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        category: 'attachment',
        role: 'input',
    };
}

export const AttachmentsInlineImages = React.memo(function AttachmentsInlineImages(props: Readonly<{
    sessionId: string;
    attachments: readonly InlineImageAttachmentSummary[];
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
    mediaPreviewEnabled: boolean;
}>) {
    const media = React.useMemo(
        () => props.attachments.map((attachment) => attachmentToSessionMedia(attachment)),
        [props.attachments],
    );

    return (
        <SessionMediaInlineImages
            sessionId={props.sessionId}
            media={media}
            onOpenPath={props.onOpenPath}
            fileOpenEnabled={props.fileOpenEnabled}
            mediaPreviewEnabled={props.mediaPreviewEnabled}
            containerTestID="message-attachments-inline-images"
            imageTestIDPrefix="message-attachments-inline-image"
            previewTestIDPrefix="message-attachments-inline-image-preview"
        />
    );
});
