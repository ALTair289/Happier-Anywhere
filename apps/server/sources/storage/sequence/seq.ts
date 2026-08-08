import { db } from "@/storage/db";

export async function allocateUserSeq(accountId: string) {
    const user = await db.account.update({
        where: { id: accountId },
        select: { seq: true },
        data: { seq: { increment: 1 } }
    });
    const seq = user.seq;
    return seq;
}

// `allocateSessionSeq` used to live here. It advanced `Session.seq` — which makes a session unread —
// without maintaining `Session.unreadSince`, so any caller would have silently produced a session
// the unread lane could not order. (`Session.needsAttention` would have stayed correct: the database
// generates it from `seq` and the read cursor.) It had no callers anywhere in the repository and was
// removed rather than wired: `seq` is advanced by `sessionWriteService` and
// `pendingMessageTranscriptCommit`, both of which resolve the unread edge in the same statement
// through `sources/app/session/attention/sessionAttentionFacts.ts`.