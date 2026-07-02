import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import {
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { inTx } from "@/storage/inTx";
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1, SessionTurnMutationV1 } from "@happier-dev/protocol";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

import { applySessionTurnMutationInTx } from "./sessionWriteService";
import {
    hasNonIdleSessionRuntimeActivityProjection,
    IDLE_SESSION_RUNTIME_ACTIVITY_PROJECTION,
} from "./runtimeActivityProjection";

const SESSION_END_STALE_WINDOW_MS = 1000 * 60 * 10;

function resolveSessionEndTime(rawTime: unknown, now: number): number {
    let time = typeof rawTime === "number" && Number.isFinite(rawTime)
        ? Math.max(0, Math.floor(rawTime))
        : now;
    if (time > now) {
        time = now;
    }
    if (time < now - SESSION_END_STALE_WINDOW_MS) {
        return now;
    }
    return time;
}

function readMillis(value: unknown): number | null {
    if (typeof value === "bigint") {
        const millis = Number(value);
        return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (value instanceof Date) {
        const millis = value.getTime();
        return Number.isFinite(millis) ? millis : null;
    }
    return null;
}

function resolveLatestSessionActivityTime(session: {
    latestTurnStatusObservedAt?: unknown;
    meaningfulActivityAt?: unknown;
}): number | null {
    const candidates = [
        readMillis(session.latestTurnStatusObservedAt),
        readMillis(session.meaningfulActivityAt),
    ].filter((value): value is number => value !== null);
    if (candidates.length === 0) return null;
    return Math.max(...candidates);
}

export type ApplySessionEndResult =
    | {
        ok: true;
        applied: boolean;
        time: number;
        active: boolean;
        activeAt: number | null;
        latestTurnId: string | null;
        latestTurnStatus: PrimaryTurnStatusV1 | null;
        latestTurnStatusObservedAt: number | null;
        lastRuntimeIssue: SessionRuntimeIssueV1 | null;
      }
    | { ok: false; error: "session-not-found" };

type SessionEndProjection = Readonly<{
    active?: boolean;
    activeAt?: number;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    runtimeActivityActiveCount?: number;
    runtimeActivityObservedAt?: null;
    runtimeActivityExpiresAt?: null;
    runtimeActivitySourceClass?: null;
}>;

export async function applySessionEnd(params: {
    actorUserId: string;
    sessionId: string;
    time?: unknown;
    now?: number;
    skipSenderConnection?: ClientConnection;
}): Promise<ApplySessionEndResult> {
    const now = params.now ?? Date.now();
    const observedTime = typeof params.time === "number" && Number.isFinite(params.time)
        ? Math.max(0, Math.min(Math.floor(params.time), now))
        : now;
    const time = resolveSessionEndTime(params.time, now);
    const result = await inTx(async (tx) => {
        const session = await tx.session.findUnique({
            where: { id: params.sessionId, accountId: params.actorUserId },
            select: {
                id: true,
                latestTurnId: true,
                seq: true,
                pendingCount: true,
                pendingBlockedCount: true,
                lastViewedSessionSeq: true,
                pendingPermissionRequestCount: true,
                pendingUserActionRequestCount: true,
                latestTurnStatus: true,
                latestTurnStatusObservedAt: true,
                lastRuntimeIssue: true,
                meaningfulActivityAt: true,
                active: true,
                lastActiveAt: true,
                archivedAt: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityExpiresAt: true,
                runtimeActivitySourceClass: true,
            },
        });
        if (!session) {
            return { ok: false as const, error: "session-not-found" as const };
        }
        const latestActivityTime = resolveLatestSessionActivityTime(session);
        if (session.active && latestActivityTime !== null && observedTime < latestActivityTime) {
            return {
                ok: true as const,
                applied: false,
                time,
                badgeAttentionChanged: false,
                active: session.active,
                activeAt: readMillis(session.lastActiveAt),
                latestTurnId: session.latestTurnId,
                latestTurnStatus: session.latestTurnStatus as PrimaryTurnStatusV1 | null,
                latestTurnStatusObservedAt: readMillis(session.latestTurnStatusObservedAt),
                lastRuntimeIssue: session.lastRuntimeIssue as SessionRuntimeIssueV1 | null,
            };
        }

        const shouldApplyTurnEnd = Boolean(session.latestTurnId && (session.active || session.latestTurnStatus === "in_progress"));
        const shouldClearRuntimeActivity = hasNonIdleSessionRuntimeActivityProjection(session);
        if (!session.active && !shouldApplyTurnEnd && !shouldClearRuntimeActivity) {
            return {
                ok: true as const,
                applied: false,
                time,
                badgeAttentionChanged: false,
                active: session.active,
                activeAt: readMillis(session.lastActiveAt),
                latestTurnId: session.latestTurnId,
                latestTurnStatus: session.latestTurnStatus as PrimaryTurnStatusV1 | null,
                latestTurnStatusObservedAt: readMillis(session.latestTurnStatusObservedAt),
                lastRuntimeIssue: session.lastRuntimeIssue as SessionRuntimeIssueV1 | null,
            };
        }

        const turnResult = shouldApplyTurnEnd
            ? await applySessionTurnMutationInTx({
                tx,
                sessionId: params.sessionId,
                mutation: {
                    v: 1,
                    sessionId: params.sessionId,
                    mutationId: `session-end:${params.sessionId}:${time}`,
                    action: "end_session",
                    observedAt: time,
                } satisfies SessionTurnMutationV1,
                session,
                markParticipants: false,
            })
            : null;
        const didMarkInactive = session.active;

        const nextSession = {
            ...session,
            active: false,
            ...(shouldClearRuntimeActivity ? IDLE_SESSION_RUNTIME_ACTIVITY_PROJECTION : {}),
            ...(turnResult?.didApply
                ? {
                    latestTurnStatus: turnResult.latestTurnStatus,
                    latestTurnStatusObservedAt: turnResult.latestTurnStatusObservedAt,
                    lastRuntimeIssue: turnResult.lastRuntimeIssue,
                }
                : {}),
        };

        if (didMarkInactive || shouldClearRuntimeActivity) {
            await tx.session.update({
                where: { id: params.sessionId },
                data: {
                    ...(didMarkInactive
                        ? {
                            lastActiveAt: new Date(time),
                            active: false,
                            thinking: false,
                            thinkingAt: new Date(time),
                        }
                        : {}),
                    ...(shouldClearRuntimeActivity ? IDLE_SESSION_RUNTIME_ACTIVITY_PROJECTION : {}),
                },
            });
        }

        const sessionProjection: SessionEndProjection = {
            ...(didMarkInactive
                ? {
                    active: false,
                    activeAt: time,
                }
                : {}),
            ...(shouldClearRuntimeActivity ? IDLE_SESSION_RUNTIME_ACTIVITY_PROJECTION : {}),
            ...(turnResult?.didApply
                ? {
                    latestTurnId: turnResult.latestTurnId,
                    latestTurnStatus: turnResult.latestTurnStatus,
                    latestTurnStatusObservedAt: turnResult.latestTurnStatusObservedAt,
                    lastRuntimeIssue: turnResult.lastRuntimeIssue,
                }
                : {}),
        };
        const hasSessionProjection = Object.keys(sessionProjection).length > 0;
        const participantCursors = hasSessionProjection
            ? await markSessionParticipantsChanged({
                tx,
                sessionId: params.sessionId,
                hint: {
                    sessionEnd: didMarkInactive,
                    ...sessionProjection,
                },
            })
            : [];

        return {
            ok: true as const,
            applied: didMarkInactive || shouldClearRuntimeActivity || turnResult?.didApply === true,
            time,
            badgeAttentionChanged: didSessionActivityBadgeContributionChange(session, nextSession),
            didMarkInactive,
            active: false,
            activeAt: didMarkInactive ? time : readMillis(session.lastActiveAt),
            latestTurnId: nextSession.latestTurnId,
            latestTurnStatus: nextSession.latestTurnStatus as PrimaryTurnStatusV1 | null,
            latestTurnStatusObservedAt: readMillis(nextSession.latestTurnStatusObservedAt),
            lastRuntimeIssue: nextSession.lastRuntimeIssue as SessionRuntimeIssueV1 | null,
            sessionProjection: hasSessionProjection ? sessionProjection : null,
            participantCursors,
        };
    });
    if (!result.ok) return result;
    if (!result.applied) {
        return {
            ok: true,
            applied: false,
            time,
            active: result.active,
            activeAt: result.activeAt,
            latestTurnId: result.latestTurnId,
            latestTurnStatus: result.latestTurnStatus,
            latestTurnStatusObservedAt: result.latestTurnStatusObservedAt,
            lastRuntimeIssue: result.lastRuntimeIssue,
        };
    }

    if (result.didMarkInactive) {
        activityCache.markSessionInactive(params.sessionId, params.actorUserId, time);
    }
    const sessionProjection = result.sessionProjection ?? undefined;
    const participantCursors = result.participantCursors ?? [];
    if (sessionProjection) {
        await Promise.all(participantCursors.map(async ({ accountId, cursor }: SessionParticipantCursor) => {
            const payload = buildUpdateSessionUpdate(
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                sessionProjection,
            );
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
                ...(accountId === params.actorUserId && params.skipSenderConnection
                    ? { skipSenderConnection: params.skipSenderConnection }
                    : {}),
            });
        }));
    }
    const badgeParticipantCursors = participantCursors.length > 0 ? participantCursors : [{ accountId: params.actorUserId }];
    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: result.badgeAttentionChanged,
        participantCursors: badgeParticipantCursors,
    });

    if (result.didMarkInactive) {
        eventRouter.emitEphemeral({
            userId: params.actorUserId,
            payload: buildSessionActivityEphemeral(params.sessionId, false, time, false),
            recipientFilter: { type: "user-scoped-only" },
        });
    }

    return {
        ok: true,
        applied: result.applied,
        time,
        active: result.active,
        activeAt: result.activeAt,
        latestTurnId: result.latestTurnId,
        latestTurnStatus: result.latestTurnStatus,
        latestTurnStatusObservedAt: result.latestTurnStatusObservedAt,
        lastRuntimeIssue: result.lastRuntimeIssue,
    };
}
