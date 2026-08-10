import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { markDirectSessionUserMessageMeta } from '@/sync/domains/messages/directSessionUserMessageProvenance';
import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';

export function normalizeDirectTranscriptMessages(items: ReadonlyArray<DirectTranscriptRawMessageV1>): NormalizedMessage[] {
    const out: NormalizedMessage[] = [];
    for (const item of items) {
        const normalized = normalizeRawMessage(
            item.id,
            typeof item.localId === 'string' ? item.localId : null,
            item.createdAtMs,
            item.raw,
            { messageRole: item.messageRole ?? undefined },
        );
        if (!normalized) continue;
        if (normalized.role === 'user') {
            out.push({
                ...normalized,
                meta: markDirectSessionUserMessageMeta(normalized.meta),
            });
            continue;
        }
        out.push(normalized);
    }
    return out;
}
