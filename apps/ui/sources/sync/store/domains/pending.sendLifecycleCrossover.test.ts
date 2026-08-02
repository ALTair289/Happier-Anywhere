import { beforeEach, describe, expect, it } from 'vitest';

import { buildChatListItems, type ChatListItem } from '@/components/sessions/chatListItems';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createMessagesDomain } from '@/sync/store/domains/messages';
import { createPendingDomain } from '@/sync/store/domains/pending';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

/**
 * The crossover contract, asserted across the states ONE SEND actually passes through.
 *
 * `pending.commitCrossover.test.ts` and `components/sessions/chatListItems.crossoverFrames.test.ts`
 * already assert the invariant per STORE WRITER, using the post-ack projection shape
 * (`local_outbound` + `deliveryStatus: 'accepted'`). This file is the other axis: one writer
 * (a server pending snapshot that omits the row) against every PROJECTION SHAPE
 * `sync/sync.ts#sendMessage` and `sync/engine/pending/pendingQueueV2.ts` put a single utterance
 * through. The two axes together cover the matrix; neither covers it alone.
 *
 * Why the shape axis matters, measured: on device, the transcript still publishes a frame carrying
 * NEITHER row during the send crossover — the list reverts to its exact pre-send content for
 * ~0.6-1.1 s (`.project/reviews/2026-08-01-send-transition/U2-app-data-revert.md`, 12/12 defect
 * captures; the 8 captures without that frame have no defect). `sendMessage` writes the local
 * projection with NO `deliveryStatus` (sync.ts, "Track this outbound user message in the local
 * pending queue"), and only upgrades it to `accepted` after the runtime RPC acknowledges. The
 * pre-ack window is real time on a cold session open, and the retention rule that protects the
 * accepted shape must protect the same row in it.
 *
 * OWNERSHIP is the rule under test, exactly as `pending.ts` states it, and it cuts BOTH ways:
 *   - no `pendingOutboxScope` and no `pendingDeliveryStatus` => the server pending queue never
 *     learned about this row, so a snapshot that omits it says nothing about it and must not
 *     retire it. `sync/engine/pending/pendingQueueV2.ts#reconcileServerPendingSnapshotWithLocalOutbound`
 *     (`preservedUnscopedLocalOutbound`) already resolves it that way and does NOT consult
 *     `deliveryStatus`; the store must not disagree with the owner it was aligned to.
 *   - `pendingOutboxScope` present => the queue addresses the row by that scope and IS
 *     authoritative for it, including "absent". That case is asserted too, so the retention rule
 *     cannot be widened into a blanket "never retire", which would strand a remotely deleted row.
 */

const SESSION_ID = 's1';
const LOCAL_ID = 'utterance-1';
const OUTBOX_SCOPE = { serverId: 'server-1', accountId: 'account-1' } as const;

function baseProjection(): PendingMessage {
    return {
        id: LOCAL_ID,
        localId: LOCAL_ID,
        createdAt: 1_000,
        updatedAt: 1_000,
        source: 'local_outbound',
        text: 'hello',
        rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } },
    };
}

function committedTwin() {
    return {
        id: 'committed-1',
        seq: 7,
        localId: LOCAL_ID,
        createdAt: 1_000,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text: 'hello' },
    } as any;
}

type PublishedFrame = Readonly<{
    pendingMessages: PendingMessage[];
    discardedMessages: PendingMessage[];
    messageIdsOldestFirst: string[];
    messagesById: Record<string, { localId?: string | null }>;
}>;

function createSendHarness() {
    const frames: PublishedFrame[] = [];
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        machines: {},
        machineDisplayById: {},
        settings: {},
        sessionPending: {},
        sessionMessages: {},
    };

    const capture = () => {
        const pending = state.sessionPending[SESSION_ID];
        const messages = state.sessionMessages[SESSION_ID];
        frames.push({
            pendingMessages: pending?.messages ?? [],
            discardedMessages: pending?.discarded ?? [],
            messageIdsOldestFirst: messages?.messageIdsOldestFirst ?? [],
            messagesById: messages?.messagesById ?? {},
        });
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        if (next === state) return;
        state = { ...state, ...next };
        capture();
    };

    const messages = createMessagesDomain({ get, set } as any);
    const pending = createPendingDomain({ get, set } as any);
    state = { ...state, ...messages, ...pending };

    return { frames, messages, pending };
}

/** Does this published frame render a row for the utterance at all? */
function rendersUtterance(frame: PublishedFrame): boolean {
    const items: ChatListItem[] = buildChatListItems({
        messageIdsOldestFirst: frame.messageIdsOldestFirst,
        messagesById: frame.messagesById as any,
        pendingMessages: frame.pendingMessages as any,
        discardedMessages: frame.discardedMessages as any,
    });
    return items.some((item) => {
        if (item.kind === 'pending-queue') {
            return [...item.pendingMessages, ...item.discardedMessages]
                .some((record) => (record.localId ?? record.id) === LOCAL_ID);
        }
        return item.kind === 'message' && frame.messagesById[item.messageId]?.localId === LOCAL_ID;
    });
}

function framesLosingTheUtterance(frames: readonly PublishedFrame[]): number[] {
    return frames.flatMap((frame, index) => (rendersUtterance(frame) ? [] : [index]));
}

/**
 * Every shape one utterance's projection takes between the composer submit and the committed twin.
 * `ownership: 'local'` means the server pending queue was never told about this row.
 */
const SEND_LIFECYCLE_SHAPES: readonly Readonly<{
    name: string;
    ownership: 'local' | 'server';
    origin: string;
    projection: PendingMessage;
}>[] = [
    {
        name: 'pre-ack optimistic projection',
        ownership: 'local',
        origin: 'sync/sync.ts#sendMessage, before the runtime RPC / socket ack',
        projection: baseProjection(),
    },
    {
        name: 'accepted direct send',
        ownership: 'local',
        origin: 'sync/sync.ts#sendMessage, after the runtime RPC ack',
        projection: { ...baseProjection(), deliveryStatus: 'accepted' },
    },
    {
        name: 'ack-timeout unconfirmed send',
        ownership: 'local',
        origin: 'sync/sync.ts#sendMessage, socket ack timeout branch',
        projection: { ...baseProjection(), deliveryStatus: 'queued', sendState: 'unconfirmed' },
    },
    {
        name: 'durable outbox projection',
        ownership: 'server',
        origin: 'sync/engine/pending/pendingQueueV2.ts#buildPendingOutboxProjection',
        projection: {
            ...baseProjection(),
            deliveryStatus: 'queued',
            pendingOutboxScope: OUTBOX_SCOPE,
            pendingOutboxOperation: 'enqueue',
            sendState: 'unconfirmed',
        },
    },
];

beforeEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('send crossover: a server snapshot only retires the rows the server owns', () => {
    for (const shape of SEND_LIFECYCLE_SHAPES) {
        if (shape.ownership !== 'local') continue;

        it(`keeps the utterance rendered when a snapshot omits the ${shape.name}`, () => {
            const harness = createSendHarness();
            harness.pending.upsertPendingMessage(SESSION_ID, shape.projection);

            // A pending refresh that landed mid-send. It names no row for this utterance, so it
            // carries no authority over a projection the queue never received.
            harness.pending.applyPendingSnapshot(SESSION_ID, { messages: [], discarded: [] });
            harness.messages.applyMessages(SESSION_ID, [committedTwin()]);

            expect(framesLosingTheUtterance(harness.frames)).toEqual([]);
        });
    }

    it('retires a durable outbox projection the snapshot omits, because that queue owns it', () => {
        const shape = SEND_LIFECYCLE_SHAPES.find((entry) => entry.ownership === 'server');
        expect(shape).toBeDefined();
        const harness = createSendHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, shape!.projection);

        harness.pending.applyPendingSnapshot(SESSION_ID, { messages: [], discarded: [] });

        expect(harness.frames.at(-1)?.pendingMessages).toEqual([]);
    });

    it('still retires every locally owned shape once its committed twin exists', () => {
        for (const shape of SEND_LIFECYCLE_SHAPES) {
            if (shape.ownership !== 'local') continue;
            const harness = createSendHarness();
            harness.pending.upsertPendingMessage(SESSION_ID, shape.projection);

            harness.messages.applyMessages(SESSION_ID, [committedTwin()]);
            harness.pending.applyPendingSnapshot(SESSION_ID, { messages: [], discarded: [] });

            const settled = harness.frames.at(-1)!;
            expect(settled.pendingMessages, shape.name).toEqual([]);
            expect(rendersUtterance(settled), shape.name).toBe(true);
        }
    });
});
