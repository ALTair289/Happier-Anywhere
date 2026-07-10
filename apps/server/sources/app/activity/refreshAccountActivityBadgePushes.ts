import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { collectExpoPushTokensMarkedUnregistered } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

import { computeAccountActivityBadgeCounts } from "./accountActivityBadge";

const expo = new Expo();
const SESSION_PARTICIPANT_BADGE_REFRESH_DEBOUNCE_MS = 1_000;

type BadgeRefreshDelivery = Readonly<{
    accountId: string;
    token: string;
    message: ExpoPushMessage;
}>;

const scheduledBadgeRefreshAccountIds = new Set<string>();
let scheduledBadgeRefreshTimer: ReturnType<typeof setTimeout> | null = null;

async function deleteInvalidAccountPushTokens(deliveries: ReadonlyArray<BadgeRefreshDelivery>): Promise<void> {
    if (deliveries.length === 0) return;
    await db.accountPushToken.deleteMany({
        where: {
            OR: deliveries.map((delivery) => ({
                accountId: delivery.accountId,
                token: delivery.token,
            })),
        },
    });
}

async function sendExpoBadgeRefreshMessages(deliveries: ReadonlyArray<BadgeRefreshDelivery>): Promise<void> {
    const validDeliveries = deliveries.filter((delivery) => Expo.isExpoPushToken(delivery.message.to));
    if (validDeliveries.length === 0) return;
    const invalidDeliveries = new Map<string, BadgeRefreshDelivery>();
    let deliveryOffset = 0;

    for (const chunk of expo.chunkPushNotifications(validDeliveries.map((delivery) => delivery.message))) {
        const chunkDeliveries = validDeliveries.slice(deliveryOffset, deliveryOffset + chunk.length);
        deliveryOffset += chunk.length;
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            const invalidTokens = new Set(
                collectExpoPushTokensMarkedUnregistered({
                    messages: chunk,
                    tickets: ticketChunk,
                }),
            );
            if (invalidTokens.size > 0) {
                for (const delivery of chunkDeliveries) {
                    if (!invalidTokens.has(delivery.token)) continue;
                    invalidDeliveries.set(`${delivery.accountId}:${delivery.token}`, delivery);
                }
            }
        } catch (error) {
            log({ module: "activity-badges", level: "warn" }, "failed to send Expo badge refresh chunk", error);
        }
    }

    await deleteInvalidAccountPushTokens([...invalidDeliveries.values()]);
}

export async function refreshAccountActivityBadgePushes(params: Readonly<{ accountIds: ReadonlyArray<string> }>): Promise<void> {
    const accountIds = [...new Set(params.accountIds.filter((accountId) => typeof accountId === "string" && accountId.trim().length > 0))];
    if (accountIds.length === 0) return;

    const [badgeCounts, pushTokens] = await Promise.all([
        computeAccountActivityBadgeCounts(accountIds),
        db.accountPushToken.findMany({
            where: { accountId: { in: accountIds } },
            select: { accountId: true, token: true },
        }),
    ]);

    const deliveries: BadgeRefreshDelivery[] = [];
    for (const pushToken of pushTokens) {
        deliveries.push({
            accountId: pushToken.accountId,
            token: pushToken.token,
            message: {
                to: pushToken.token,
                badge: badgeCounts.get(pushToken.accountId) ?? 0,
                data: { type: "badge_refresh" },
            },
        });
    }

    await sendExpoBadgeRefreshMessages(deliveries);
}

function scheduleAccountActivityBadgePushRefresh(accountIds: ReadonlyArray<string>): void {
    for (const accountId of accountIds) {
        const normalizedAccountId = accountId.trim();
        if (normalizedAccountId.length > 0) {
            scheduledBadgeRefreshAccountIds.add(normalizedAccountId);
        }
    }
    if (scheduledBadgeRefreshAccountIds.size === 0 || scheduledBadgeRefreshTimer) return;

    scheduledBadgeRefreshTimer = setTimeout(() => {
        scheduledBadgeRefreshTimer = null;
        const accountIdsToRefresh = [...scheduledBadgeRefreshAccountIds];
        scheduledBadgeRefreshAccountIds.clear();
        void refreshAccountActivityBadgePushes({ accountIds: accountIdsToRefresh }).catch((error) => {
            log({ module: "activity-badges", level: "warn" }, "failed to refresh scheduled badge pushes", error);
        });
    }, SESSION_PARTICIPANT_BADGE_REFRESH_DEBOUNCE_MS);
    if (typeof (scheduledBadgeRefreshTimer as { unref?: unknown }).unref === "function") {
        (scheduledBadgeRefreshTimer as { unref: () => void }).unref();
    }
}

export async function refreshSessionParticipantBadgePushes(params: Readonly<{
    badgeAttentionChanged: boolean;
    participantCursors: ReadonlyArray<{ accountId: string }>;
}>): Promise<void> {
    if (!params.badgeAttentionChanged) return;
    scheduleAccountActivityBadgePushRefresh(params.participantCursors.map(({ accountId }) => accountId));
}
