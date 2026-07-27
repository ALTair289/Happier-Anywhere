import { createHash } from 'node:crypto';

export function createCodexRolloutFileIdentity(identity: Readonly<{
    dev: number | bigint;
    ino: number | bigint;
}>): string {
    const hash = createHash('sha256');
    for (const part of [
        'codex-rollout-file-identity-v1',
        identity.dev.toString(),
        identity.ino.toString(),
    ]) {
        hash.update(part, 'utf8');
        hash.update(Buffer.from([0]));
    }
    return hash.digest('hex');
}

export function createCodexRolloutEffectLocalId(params: Readonly<{
    fileIdentity: string;
    lineStartOffsetBytes: number;
    effectIndex: number;
}>): string {
    const hash = createHash('sha256');
    for (const part of [
        'codex-rollout-effect-v1',
        params.fileIdentity,
        String(params.lineStartOffsetBytes),
        String(params.effectIndex),
    ]) {
        hash.update(part, 'utf8');
        hash.update(Buffer.from([0]));
    }
    return hash.digest('hex');
}
