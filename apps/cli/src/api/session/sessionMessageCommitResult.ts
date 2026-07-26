export type SessionMessageCommitResult = Readonly<{
    localId: string;
    messageId: string;
    seq: number;
    didWrite: boolean;
}>;
