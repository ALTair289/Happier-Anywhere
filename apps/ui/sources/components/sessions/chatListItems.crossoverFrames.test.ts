import { beforeEach, describe, expect, it } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createMessagesDomain } from '@/sync/store/domains/messages';
import { createPendingDomain, type PendingDomain } from '@/sync/store/domains/pending';

import { buildChatListItems, buildChatListItemsCached, type ChatListItem, type ChatListItemsBuildCache } from './chatListItems';

/**
 * The pending -> committed CROSSOVER, asserted on the PUBLISHED TRANSCRIPT ITEM LIST.
 *
 * `sync/domains/pending/pendingTranscriptProjection.ts` states the contract: for one utterance
 * localId, exactly one of {pending row, committed row} may own the tail slot "in every frame".
 * Two independent decision-makers can break it, and only one of them is a store writer:
 *
 *   1. RECORD LIFETIME (`sync/store/domains/*`): a writer retires the pending record before the
 *      committed twin exists, so the frame carries neither.
 *   2. ROW VISIBILITY (this module + `pendingTranscriptProjection`): the record and the twin both
 *      exist in the store, but the crossover resolution hides both.
 *
 * `sync/store/domains/pending.commitCrossover.test.ts` covers (1) at the record level and cannot
 * see (2). This file asserts the invariant where it is actually consumed — the item array handed to
 * the list renderer, whose length is the painted content height Legend clamps the tail scroll
 * against (`.project/reviews/2026-08-01-send-transition/`). A frame that loses the slot is a
 * transcript one row shorter mid-send.
 *
 * These assertions are over the INTERMEDIATE frames. The settled frame is already correct today, so
 * a settled-only assertion would be vacuous.
 */

const SESSION_ID = 's1';
const LOCAL_ID = 'utterance-1';

type PendingRecord = { id: string; localId?: string | null };

type PublishedFrame = Readonly<{
    pendingMessages: PendingRecord[];
    discardedMessages: PendingRecord[];
    messageIdsOldestFirst: string[];
    messagesById: Record<string, { localId?: string | null }>;
}>;

function acceptedLocalOutboundProjection() {
    return {
        id: LOCAL_ID,
        localId: LOCAL_ID,
        createdAt: 1_000,
        updatedAt: 1_000,
        source: 'local_outbound' as const,
        deliveryStatus: 'accepted' as const,
        text: 'hello',
        rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } } as any,
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

function createCrossoverHarness() {
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

    return { frames, get, messages, pending };
}

/**
 * Which row owns the utterance's tail slot in one published frame, resolved through the REAL
 * builders rather than through the raw store records.
 *
 * Both builders are live: `buildChatListItemsCached` is what the transcript uses in its default
 * grouping mode and it carries a reuse cache across frames, so it is replayed with the cache fed
 * forward exactly as the render memo does (`transcript/items/useTranscriptRootDerivedItems.ts`).
 */
function describeSlotOwners(items: readonly ChatListItem[], messagesById: Record<string, { localId?: string | null }>) {
    const carriesUtterance = (record: PendingRecord) => (record.localId ?? record.id) === LOCAL_ID;
    let pendingRow = false;
    let committedRow = false;
    for (const item of items) {
        if (item.kind === 'pending-queue') {
            if (item.pendingMessages.some(carriesUtterance) || item.discardedMessages.some(carriesUtterance)) {
                pendingRow = true;
            }
            continue;
        }
        if (item.kind === 'message' && messagesById[item.messageId]?.localId === LOCAL_ID) {
            committedRow = true;
        }
    }
    return { pendingRow, committedRow };
}

type FrameProjection = Readonly<{ builder: string; index: number; owners: ReturnType<typeof describeSlotOwners>; length: number }>;

function projectFrames(frames: readonly PublishedFrame[]): FrameProjection[] {
    const out: FrameProjection[] = [];
    let cache: ChatListItemsBuildCache | null = null;
    frames.forEach((frame, index) => {
        const linear = buildChatListItems({
            messageIdsOldestFirst: frame.messageIdsOldestFirst,
            messagesById: frame.messagesById as any,
            pendingMessages: frame.pendingMessages as any,
            discardedMessages: frame.discardedMessages as any,
        });
        const cached = buildChatListItemsCached({
            cache,
            messageIdsOldestFirst: frame.messageIdsOldestFirst,
            messagesById: frame.messagesById as any,
            pendingMessages: frame.pendingMessages as any,
            discardedMessages: frame.discardedMessages as any,
        });
        cache = cached.cache;
        out.push({ builder: 'linear', index, owners: describeSlotOwners(linear, frame.messagesById), length: linear.length });
        out.push({ builder: 'cached', index, owners: describeSlotOwners(cached.items, frame.messagesById), length: cached.items.length });
    });
    return out;
}

/** Frames in which the utterance has NO row at all — the defect this contract exists to forbid. */
function framesWithoutTheUtterance(projections: readonly FrameProjection[]): FrameProjection[] {
    return projections.filter((p) => !p.owners.pendingRow && !p.owners.committedRow);
}

/** Frames in which the utterance is rendered twice at once. */
function framesWithBothRows(projections: readonly FrameProjection[]): FrameProjection[] {
    return projections.filter((p) => p.owners.pendingRow && p.owners.committedRow);
}

/**
 * Every action the pending domain exposes, classified by who owns retiring a locally owned
 * projection that the server has ACCEPTED but that has not committed yet.
 *
 * A new action added to `PendingDomain` fails `classifies every pending-domain action` below until
 * it is listed here, and listing it as `server` automatically subjects it to the crossover
 * invariant. That is the guard: the seventh writer cannot be added silently.
 */
const PENDING_DOMAIN_ACTIONS: readonly Readonly<{
    name: keyof PendingDomain;
    ownership: 'server' | 'owner' | 'not-a-retirement';
    retire?: (pending: PendingDomain) => void;
}>[] = [
    // Server-state reconciliation. None of these has the committed twin in hand, so none of them
    // may retire the projection: doing so publishes a frame with neither row.
    { name: 'pruneServerPendingMessages', ownership: 'server', retire: (p) => p.pruneServerPendingMessages(SESSION_ID) },
    { name: 'applyPendingSnapshot', ownership: 'server', retire: (p) => p.applyPendingSnapshot(SESSION_ID, { messages: [], discarded: [] }) },
    { name: 'applyPendingMessages', ownership: 'server', retire: (p) => p.applyPendingMessages(SESSION_ID, []) },
    { name: 'applyDiscardedPendingMessages', ownership: 'server', retire: (p) => p.applyDiscardedPendingMessages(SESSION_ID, []) },
    // Owner-driven retirement: no committed twin is ever coming, so the lone removal is correct.
    { name: 'removePendingMessage', ownership: 'owner' },
    { name: 'upsertPendingMessage', ownership: 'not-a-retirement' },
    { name: 'applyPendingLoaded', ownership: 'not-a-retirement' },
];

beforeEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('transcript item list: the pending -> committed crossover never loses the utterance', () => {
    it('classifies every pending-domain action against the crossover invariant', () => {
        const harness = createCrossoverHarness();
        const actions = Object.entries(harness.pending)
            .filter(([, value]) => typeof value === 'function')
            .map(([name]) => name)
            .sort();
        const classified = PENDING_DOMAIN_ACTIONS.map((entry) => entry.name as string).sort();

        expect(actions).toEqual(classified);
    });

    for (const entry of PENDING_DOMAIN_ACTIONS) {
        if (entry.ownership !== 'server' || !entry.retire) continue;

        it(`keeps the utterance rendered when ${String(entry.name)} lands before the committed twin`, () => {
            const harness = createCrossoverHarness();
            harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());
            const settledBefore = harness.frames.length - 1;

            entry.retire!(harness.pending);
            harness.messages.applyMessages(SESSION_ID, [committedTwin()]);

            const projections = projectFrames(harness.frames);
            expect(framesWithoutTheUtterance(projections)).toEqual([]);
            expect(framesWithBothRows(projections)).toEqual([]);

            // The geometric statement of the same invariant: the list never shrinks below either
            // endpoint mid-crossover. That dip is the painted row-height excursion.
            const endpoints = projections.filter((p) => p.index === settledBefore || p.index === harness.frames.length - 1);
            const floor = Math.min(...endpoints.map((p) => p.length));
            expect(projections.filter((p) => p.index >= settledBefore).every((p) => p.length >= floor)).toBe(true);
        });

        it(`keeps exactly one row when ${String(entry.name)} lands after the committed twin`, () => {
            const harness = createCrossoverHarness();
            harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());

            harness.messages.applyMessages(SESSION_ID, [committedTwin()]);
            entry.retire!(harness.pending);

            const projections = projectFrames(harness.frames);
            expect(framesWithoutTheUtterance(projections)).toEqual([]);
            expect(framesWithBothRows(projections)).toEqual([]);
        });
    }

    it('does not resurrect a second row when a stale server snapshot still lists the committed utterance', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());

        harness.messages.applyMessages(SESSION_ID, [committedTwin()]);
        // A pending refresh that was already in flight when the commit landed.
        harness.pending.applyPendingSnapshot(SESSION_ID, {
            messages: [acceptedLocalOutboundProjection()] as any,
            discarded: [],
        });

        const projections = projectFrames(harness.frames);
        expect(framesWithoutTheUtterance(projections)).toEqual([]);
        expect(framesWithBothRows(projections)).toEqual([]);
    });

    it('renders the committed row in the same frame that drops the pending row', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());
        const beforeCommit = harness.frames.length;

        harness.messages.applyMessages(SESSION_ID, [committedTwin()]);

        const projections = projectFrames(harness.frames).filter((p) => p.index >= beforeCommit);
        expect(projections).not.toHaveLength(0);
        expect(projections.every((p) => p.owners.committedRow && !p.owners.pendingRow)).toBe(true);
    });
});
