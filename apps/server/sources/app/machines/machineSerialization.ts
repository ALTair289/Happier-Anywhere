export type MachineSerializationRow = Readonly<{
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    installationId?: string | null;
    installationPublicKey?: Uint8Array | null;
    contentPublicKeyFingerprint?: string | null;
    replacedByMachineId?: string | null;
    replacedAt?: Date | null;
    replacementReason?: string | null;
    replacementSource?: string | null;
    replacementActorUserId?: string | null;
    seq: number;
    active: boolean;
    lastActiveAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}>;

/**
 * The exact columns `serializeMachineRow` reads. Machine list/detail reads project through this so a
 * future column — the model already carries encrypted `metadata`/`daemonState` and key blobs — cannot
 * silently join the foreground-boot payload just by existing.
 */
export const MACHINE_SERIALIZATION_SELECT = {
    id: true,
    metadata: true,
    metadataVersion: true,
    daemonState: true,
    daemonStateVersion: true,
    dataEncryptionKey: true,
    installationId: true,
    installationPublicKey: true,
    contentPublicKeyFingerprint: true,
    replacedByMachineId: true,
    replacedAt: true,
    replacementReason: true,
    replacementSource: true,
    replacementActorUserId: true,
    seq: true,
    active: true,
    lastActiveAt: true,
    revokedAt: true,
    createdAt: true,
    updatedAt: true,
} as const;

export function serializeMachineRow(row: MachineSerializationRow) {
    return {
        id: row.id,
        metadata: row.metadata,
        metadataVersion: row.metadataVersion,
        daemonState: row.daemonState,
        daemonStateVersion: row.daemonStateVersion,
        dataEncryptionKey: row.dataEncryptionKey ? Buffer.from(row.dataEncryptionKey).toString("base64") : null,
        installationId: row.installationId ?? null,
        installationPublicKey: row.installationPublicKey ? Buffer.from(row.installationPublicKey).toString("base64") : null,
        contentPublicKeyFingerprint: row.contentPublicKeyFingerprint ?? null,
        replacedByMachineId: row.replacedByMachineId ?? null,
        replacedAt: row.replacedAt ? row.replacedAt.getTime() : null,
        replacementReason: row.replacementReason ?? null,
        replacementSource: row.replacementSource ?? null,
        replacementActorUserId: row.replacementActorUserId ?? null,
        seq: row.seq,
        active: row.active,
        activeAt: row.lastActiveAt.getTime(),
        revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}
