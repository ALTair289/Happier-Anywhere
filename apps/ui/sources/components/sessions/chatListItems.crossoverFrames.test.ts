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

/**
 * The shape the DURABLE PENDING QUEUE V2 route actually produces, measured on this build in
 * `.project/reviews/2026-08-06-simplify-and-native/C3-void-writer.md` (22/22 sends):
 * the row is born with a `pendingOutboxScope`, so lane U2's unscoped-`local_outbound` retention
 * rule never speaks for it, and the server snapshot later replaces it with a `server_pending` row
 * carrying the same localId.
 */
const OUTBOX_SCOPE = { serverId: 'server-1', accountId: 'account-1' } as const;

function durableOutboundProjection() {
    return {
        ...acceptedLocalOutboundProjection(),
        pendingOutboxScope: OUTBOX_SCOPE,
    };
}

function durableServerPendingProjection() {
    return {
        id: LOCAL_ID,
        localId: LOCAL_ID,
        createdAt: 1_000,
        updatedAt: 1_000,
        source: 'server_pending' as const,
        pendingDeliveryStatus: 'server_delivering' as const,
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
 * Frames that hand the slot BACK to the pending row after the committed row already owned it.
 *
 * The crossover is a handover, not a negotiation: a frame carrying exactly one row still breaks the
 * contract if it retracts a committed row this list already published. Measured consequence — the
 * transcript's content height moves three times for one utterance instead of once.
 */
function framesRetractingTheCommittedRow(projections: readonly FrameProjection[]): FrameProjection[] {
    const retractions: FrameProjection[] = [];
    for (const builder of new Set(projections.map((p) => p.builder))) {
        let committedOwnedSlot = false;
        for (const projection of projections.filter((p) => p.builder === builder)) {
            if (projection.owners.committedRow) {
                committedOwnedSlot = true;
                continue;
            }
            if (committedOwnedSlot && projection.owners.pendingRow) retractions.push(projection);
        }
    }
    return retractions;
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
            expect(framesRetractingTheCommittedRow(projections)).toEqual([]);
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

    /**
     * The route a real send actually takes on this build (durable pending queue V2), in the
     * ordering a slow client produces: the local projection is retired by `applyMessages` in the
     * same store update that appends the committed twin, and the server's pending snapshot for that
     * same send — an HTTP round trip racing a socket push — lands afterwards.
     *
     * This asserts the FRAMES for the sequence the snapshot owner is required to publish. The
     * decision that the stale row must not be republished is NOT the store's and is not testable
     * here: `applyPendingSnapshot` cannot tell a stale re-assertion from a first read, so the fence
     * lives at the read's capture point in
     * `sync/engine/pending/pendingQueueV2.ts#withholdPendingRowsCommittedAfterSnapshotCapture`
     * (RED/GREEN in `pendingQueueV2.committedCrossover.test.ts`). What this file owns is the
     * consequence: with the row withheld, the committed row keeps the slot it already took.
     */
    it('keeps the committed row when the fenced snapshot lands after the committed twin', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, durableOutboundProjection());

        harness.messages.applyMessages(SESSION_ID, [committedTwin()]);
        harness.pending.applyPendingSnapshot(SESSION_ID, { messages: [], discarded: [] });

        const projections = projectFrames(harness.frames);
        expect(framesWithoutTheUtterance(projections)).toEqual([]);
        expect(framesWithBothRows(projections)).toEqual([]);
        expect(framesRetractingTheCommittedRow(projections)).toEqual([]);
        expect(projections.slice(-2).every((p) => p.owners.committedRow && !p.owners.pendingRow)).toBe(true);
    });

    /**
     * The other ordering, unchanged: while the client still HOLDS the durable row, the server owns
     * its removal and it keeps the slot across the commit
     * (`sync/domains/pending/pendingTranscriptProjection.ts`). Only the release is one-way.
     */
    it('lets a durable pending row it still holds keep the slot across the commit', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, durableOutboundProjection());
        harness.pending.applyPendingSnapshot(SESSION_ID, {
            messages: [durableServerPendingProjection()] as any,
            discarded: [],
        });

        harness.messages.applyMessages(SESSION_ID, [committedTwin()]);
        const afterCommit = projectFrames(harness.frames).filter((p) => p.index === harness.frames.length - 1);
        expect(afterCommit).not.toHaveLength(0);
        expect(afterCommit.every((p) => p.owners.pendingRow && !p.owners.committedRow)).toBe(true);

        harness.pending.pruneServerPendingMessages(SESSION_ID);

        const projections = projectFrames(harness.frames);
        expect(framesWithoutTheUtterance(projections)).toEqual([]);
        expect(framesWithBothRows(projections)).toEqual([]);
        expect(framesRetractingTheCommittedRow(projections)).toEqual([]);
        expect(projections.slice(-2).every((p) => p.owners.committedRow && !p.owners.pendingRow)).toBe(true);
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
