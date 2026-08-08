import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

/**
 * Read the current change cursor of each account without allocating a new one.
 *
 * `markAccountChanged` allocates a cursor by incrementing `Account.seq` — the correct behavior for a
 * durable content change, because it is what makes the change observable through `/v2/changes`.
 * A pure liveness tick is not a content change: it is delivered on the live push channel only, so it
 * must not write the account's shared sequence row or rewrite the coalesced `AccountChange` row.
 * Such a push still has to carry a cursor, and this returns the truthful current one.
 */
export async function readAccountChangeCursors(params: Readonly<{
    accountIds: readonly string[];
    tx?: Tx;
}>): Promise<Map<string, number>> {
    const accountIds = Array.from(new Set(params.accountIds.filter((id) => typeof id === "string" && id.length > 0)));
    if (accountIds.length === 0) return new Map();

    const rows = await (params.tx ?? db).account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, seq: true },
    });
    return new Map(rows.map((row) => [row.id, row.seq]));
}
