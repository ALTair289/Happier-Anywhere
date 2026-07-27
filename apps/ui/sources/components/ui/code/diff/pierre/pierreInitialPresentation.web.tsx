import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export function buildPierreInitialPresentationCacheKey(params: Readonly<{
    fileName: string;
    language: string | null;
    patch: string;
}>): string {
    const content = `${params.fileName}\0${params.language ?? ''}\0${params.patch}`;
    return `happier-pierre-diff:v1:${bytesToHex(sha256(utf8ToBytes(content)))}`;
}
