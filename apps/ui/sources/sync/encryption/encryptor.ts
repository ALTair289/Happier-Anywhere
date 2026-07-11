import { decryptBox, decryptSecretBox, encryptBox, encryptSecretBox } from "@/encryption/libsodium";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium from '@/encryption/libsodium.lib';
import { decodeUTF8, encodeUTF8 } from "@/encryption/text";
import { decryptAESGCMString, encryptAESGCMString } from "@/encryption/aes";
import { parseSerializedJsonValue, stringifySerializedJsonValue } from '@happier-dev/protocol';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import {
    decryptAesGcmJsonBase64BatchWithNativeWorker,
    decryptAesGcmJsonBatchWithNativeWorker,
    decryptSecretboxJsonBase64BatchWithNativeWorker,
    decryptSecretboxJsonBatchWithNativeWorker,
    type NativeJsonDecryptWorkerBinding,
} from './nativeCryptoWorker/nativeJsonDecryptBatch';
import {
    decryptAesGcmJsonBase64BatchWithWebWorker,
    estimateBase64DecodedBytes,
    normalizeLargeJsonDecryptPayloadBytes,
    type AesGcmJsonWebWorkerOptions,
} from './webCryptoJsonWorker/webJsonDecryptBatch';

//
// IMPORTANT: Right now there is a bug in the AES implementation and it works only with a normal strings converted to Uint8Array. 
// Any abnormal string might break encoding and decoding utf8.
//

export interface Encryptor {
    encrypt(data: any[]): Promise<Uint8Array[]>;
}

export interface Decryptor {
    decrypt(data: Uint8Array[], options?: DecryptOptions): Promise<(any | null)[]>;
}

export interface Base64Decryptor {
    decryptBase64(data: readonly string[], options?: DecryptOptions): Promise<(any | null)[]>;
    shouldDecryptBase64?(data: readonly string[]): boolean;
}

export type DecryptOptions = Readonly<{
    signal?: AbortSignal;
}>;

type MaybeBase64Decryptor = Decryptor & Partial<Base64Decryptor>;

export function hasBase64Decryptor(decryptor: Decryptor): decryptor is Decryptor & Base64Decryptor {
    const candidate = decryptor as MaybeBase64Decryptor;
    return typeof candidate.decryptBase64 === 'function';
}

export function shouldUseBase64Decryptor(decryptor: Decryptor, data: readonly string[]): decryptor is Decryptor & Base64Decryptor {
    if (!hasBase64Decryptor(decryptor)) return false;
    return decryptor.shouldDecryptBase64?.(data) ?? true;
}

export type SecretBoxEncryptionOptions = Readonly<{
    nativeCryptoWorker?: NativeJsonDecryptWorkerBinding;
}>;

type AesStringCryptoAdapter = Readonly<{
    encryptString: (data: string, key64: string) => Promise<string>;
    decryptString: (data: string, key64: string) => Promise<string | null>;
}>;

export type AES256EncryptionOptions = Partial<AesStringCryptoAdapter> & Readonly<{
    batchConcurrencyLimit?: number;
    largePayloadYieldBytes?: number;
    nativeCryptoWorker?: NativeJsonDecryptWorkerBinding;
    webJsonDecryptWorker?: AesGcmJsonWebWorkerOptions;
    yieldBetweenLargePayloadDecrypts?: () => Promise<void>;
}>;

export const DEFAULT_AES_BATCH_CONCURRENCY_LIMIT = 4;

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export function normalizeAesBatchConcurrencyLimit(value: number | null | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_AES_BATCH_CONCURRENCY_LIMIT;
    }
    return Math.max(1, Math.trunc(value));
}

async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrencyLimit: number,
    mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }

    const results = new Array<R>(items.length);
    const workerCount = Math.min(items.length, normalizeAesBatchConcurrencyLimit(concurrencyLimit));
    let nextIndex = 0;

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) {
                return;
            }
            results[index] = await mapper(items[index]!, index);
        }
    }));

    return results;
}

export class SecretBoxEncryption implements Encryptor, Decryptor {
    private readonly secretKey: Uint8Array;
    private readonly nativeCryptoWorker?: NativeJsonDecryptWorkerBinding;
    readonly decryptBase64?: (data: readonly string[], options?: DecryptOptions) => Promise<(any | null)[]>;

    constructor(secretKey: Uint8Array, options: SecretBoxEncryptionOptions = {}) {
        this.secretKey = secretKey;
        this.nativeCryptoWorker = options.nativeCryptoWorker;
        if (this.nativeCryptoWorker) {
            this.decryptBase64 = async (data, decryptOptions) => this.decryptBase64WithNativeWorker(data, decryptOptions);
        }
    }

    private decryptReference(data: readonly Uint8Array[]): (any | null)[] {
        const results: (any | null)[] = [];
        for (const item of data) {
            results.push(decryptSecretBox(item, this.secretKey));
        }
        return results;
    }

    async decrypt(data: Uint8Array[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.secretbox.decrypt',
            { items: data.length },
            async () => {
                const referenceRun = async () => this.decryptReference(data);
                if (this.nativeCryptoWorker) {
                    return await decryptSecretboxJsonBatchWithNativeWorker(
                        data,
                        this.secretKey,
                        this.nativeCryptoWorker,
                        referenceRun,
                        { signal: options.signal },
                    );
                }
                return await referenceRun();
            },
        );
    }

    private decryptBase64Reference(data: readonly string[]): (any | null)[] {
        const results: (any | null)[] = [];
        for (const item of data) {
            try {
                results.push(decryptSecretBox(decodeBase64(item, 'base64'), this.secretKey));
            } catch {
                results.push(null);
            }
        }
        return results;
    }

    private async decryptBase64WithNativeWorker(data: readonly string[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.secretbox.decrypt',
            { items: data.length },
            async () => {
                const referenceRun = async () => this.decryptBase64Reference(data);
                if (this.nativeCryptoWorker) {
                    return await decryptSecretboxJsonBase64BatchWithNativeWorker(
                        data,
                        this.secretKey,
                        this.nativeCryptoWorker,
                        referenceRun,
                        { signal: options.signal },
                    );
                }
                return await referenceRun();
            },
        );
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        return syncPerformanceTelemetry.measure(
            'sync.encryption.crypto.secretbox.encrypt',
            { items: data.length },
            () => {
                // Process as batch, not Promise.all - more efficient
                const results: Uint8Array[] = [];
                for (const item of data) {
                    results.push(encryptSecretBox(item, this.secretKey));
                }
                return results;
            },
        );
    }
}

export class BoxEncryption implements Encryptor, Decryptor {
    private readonly privateKey: Uint8Array;
    private readonly publicKey: Uint8Array;

    constructor(seed: Uint8Array) {
        // Use the seed to generate a proper keypair
        const keypair = sodium.crypto_box_seed_keypair(seed);
        this.privateKey = keypair.privateKey;
        this.publicKey = keypair.publicKey;
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        return syncPerformanceTelemetry.measure(
            'sync.encryption.crypto.box.encrypt',
            { items: data.length },
            () => {
                // Process as batch, not Promise.all - more efficient
                const results: Uint8Array[] = [];
                for (const item of data) {
                    results.push(encryptBox(encodeUTF8(stringifySerializedJsonValue(item)), this.publicKey));
                }
                return results;
            },
        );
    }

    async decrypt(data: Uint8Array[], _options: DecryptOptions = {}): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measure(
            'sync.encryption.crypto.box.decrypt',
            { items: data.length },
            () => {
                // Process as batch, not Promise.all - more efficient
                const results: (any | null)[] = [];
                for (const item of data) {
                    let decrypted = decryptBox(item, this.privateKey);
                    if (!decrypted) {
                        results.push(null);
                        continue;
                    }
                    results.push(parseSerializedJsonValue(decodeUTF8(decrypted)));
                }
                return results;
            },
        );
    }
}

export class AES256Encryption implements Encryptor, Decryptor {
    private readonly secretKey: Uint8Array;
    private readonly secretKeyB64: string;
    private readonly batchConcurrencyLimit: number;
    private readonly encryptString: AesStringCryptoAdapter['encryptString'];
    private readonly decryptString: AesStringCryptoAdapter['decryptString'];
    private readonly largePayloadYieldBytes: number;
    private readonly nativeCryptoWorker?: NativeJsonDecryptWorkerBinding;
    private readonly webJsonDecryptWorker: AesGcmJsonWebWorkerOptions;
    private readonly yieldBetweenLargePayloadDecrypts: () => Promise<void>;
    readonly decryptBase64?: (data: readonly string[], options?: DecryptOptions) => Promise<(any | null)[]>;
    readonly shouldDecryptBase64: (data: readonly string[]) => boolean;

    constructor(secretKey: Uint8Array, options: AES256EncryptionOptions = {}) {
        this.secretKey = secretKey;
        this.secretKeyB64 = encodeBase64(secretKey);
        this.batchConcurrencyLimit = normalizeAesBatchConcurrencyLimit(options.batchConcurrencyLimit);
        this.encryptString = options.encryptString ?? encryptAESGCMString;
        this.decryptString = options.decryptString ?? decryptAESGCMString;
        this.largePayloadYieldBytes = normalizeLargeJsonDecryptPayloadBytes(options.largePayloadYieldBytes);
        this.nativeCryptoWorker = options.nativeCryptoWorker;
        this.webJsonDecryptWorker = options.webJsonDecryptWorker ?? {};
        this.yieldBetweenLargePayloadDecrypts = options.yieldBetweenLargePayloadDecrypts ?? yieldToEventLoop;
        this.decryptBase64 = async (data, decryptOptions) => this.decryptBase64Batch(data, decryptOptions);
        this.shouldDecryptBase64 = (data) => this.nativeCryptoWorker !== undefined || this.hasLargeBase64Payload(data);
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.aes.encrypt',
            { items: data.length, concurrency: this.batchConcurrencyLimit },
            async () => {
                return await mapWithConcurrency(data, this.batchConcurrencyLimit, async (item) => {
                    // Serialize to JSON string first
                    const encrypted = decodeBase64(
                        await this.encryptString(stringifySerializedJsonValue(item), this.secretKeyB64)
                    );
                    let output = new Uint8Array(encrypted.length + 1);
                    output[0] = 0;
                    output.set(encrypted, 1);
                    return output;
                });
            },
        );
    }

    async decrypt(data: Uint8Array[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.aes.decrypt',
            { items: data.length, concurrency: this.batchConcurrencyLimit },
            async () => {
                const referenceRun = async () => this.decryptReference(data);
                if (this.nativeCryptoWorker) {
                    return await decryptAesGcmJsonBatchWithNativeWorker(
                        data,
                        this.secretKey,
                        this.nativeCryptoWorker,
                        referenceRun,
                        { signal: options.signal },
                    );
                }
                return await referenceRun();
            },
        );
    }

    private async decryptReference(data: readonly Uint8Array[]): Promise<(any | null)[]> {
        if (this.shouldYieldBetweenLargeBytePayloads(data)) {
            const results: (any | null)[] = [];
            let hasProcessedLargePayload = false;
            for (const item of data) {
                if (item.byteLength >= this.largePayloadYieldBytes) {
                    if (hasProcessedLargePayload) {
                        await this.yieldBetweenLargePayloadDecrypts();
                    }
                    hasProcessedLargePayload = true;
                }
                results.push(await this.decryptReferenceItem(item));
            }
            return results;
        }

        return await mapWithConcurrency(data, this.batchConcurrencyLimit, async (item) => this.decryptReferenceItem(item));
    }

    private shouldYieldBetweenLargeBytePayloads(data: readonly Uint8Array[]): boolean {
        let largePayloads = 0;
        for (const item of data) {
            if (item.byteLength >= this.largePayloadYieldBytes) {
                largePayloads += 1;
                if (largePayloads > 1) return true;
            }
        }
        return false;
    }

    private async decryptReferenceItem(item: Uint8Array): Promise<any | null> {
        try {
            if (item[0] !== 0) {
                return null;
            }
            const decryptedString = await this.decryptString(encodeBase64(item.slice(1)), this.secretKeyB64);
            if (!decryptedString) {
                return null;
            } else {
                // Parse JSON string back to object
                return parseSerializedJsonValue(decryptedString);
            }
        } catch {
            return null;
        }
    }

    private async decryptBase64Reference(data: readonly string[]): Promise<(any | null)[]> {
        const workerResult = await this.decryptLargeBase64WithWebWorker(data);
        if (workerResult) {
            return workerResult;
        }

        return await this.decryptBase64ReferenceOnJs(data);
    }

    private async decryptBase64ReferenceOnJs(data: readonly string[]): Promise<(any | null)[]> {
        if (this.shouldYieldBetweenLargeBase64Payloads(data)) {
            const results: (any | null)[] = [];
            let hasProcessedLargePayload = false;
            for (const item of data) {
                if (estimateBase64DecodedBytes(item) >= this.largePayloadYieldBytes) {
                    if (hasProcessedLargePayload) {
                        await this.yieldBetweenLargePayloadDecrypts();
                    }
                    hasProcessedLargePayload = true;
                }
                results.push(await this.decryptBase64ReferenceItem(item));
            }
            return results;
        }

        return await mapWithConcurrency(data, this.batchConcurrencyLimit, async (item) => this.decryptBase64ReferenceItem(item));
    }

    private shouldYieldBetweenLargeBase64Payloads(data: readonly string[]): boolean {
        let largePayloads = 0;
        for (const item of data) {
            if (estimateBase64DecodedBytes(item) >= this.largePayloadYieldBytes) {
                largePayloads += 1;
                if (largePayloads > 1) return true;
            }
        }
        return false;
    }

    private hasLargeBase64Payload(data: readonly string[]): boolean {
        const thresholdBytes = normalizeLargeJsonDecryptPayloadBytes(this.webJsonDecryptWorker.largePayloadThresholdBytes);
        for (const item of data) {
            if (estimateBase64DecodedBytes(item) >= thresholdBytes) {
                return true;
            }
        }
        return false;
    }

    private async decryptBase64ReferenceItem(item: string): Promise<any | null> {
        try {
            return await this.decryptReferenceItem(decodeBase64(item, 'base64'));
        } catch {
            return null;
        }
    }

    private async decryptLargeBase64WithWebWorker(data: readonly string[]): Promise<(any | null)[] | null> {
        const thresholdBytes = normalizeLargeJsonDecryptPayloadBytes(this.webJsonDecryptWorker.largePayloadThresholdBytes);
        const largeItems: Array<{ index: number; value: string }> = [];
        const smallItems: Array<{ index: number; value: string }> = [];

        for (let index = 0; index < data.length; index += 1) {
            const value = data[index]!;
            if (estimateBase64DecodedBytes(value) >= thresholdBytes) {
                largeItems.push({ index, value });
            } else {
                smallItems.push({ index, value });
            }
        }

        if (largeItems.length === 0) {
            return null;
        }

        const largeResults = await decryptAesGcmJsonBase64BatchWithWebWorker(
            largeItems.map((item) => item.value),
            this.secretKeyB64,
            this.webJsonDecryptWorker,
        );
        if (!largeResults) {
            return null;
        }

        const results: (any | null)[] = new Array(data.length);
        for (let i = 0; i < largeItems.length; i += 1) {
            results[largeItems[i]!.index] = i < largeResults.length ? largeResults[i] : null;
        }

        if (smallItems.length > 0) {
            const smallResults = await this.decryptBase64ReferenceOnJs(smallItems.map((item) => item.value));
            for (let i = 0; i < smallItems.length; i += 1) {
                results[smallItems[i]!.index] = i < smallResults.length ? smallResults[i] : null;
            }
        }

        return results;
    }

    private async decryptBase64Batch(data: readonly string[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        if (this.nativeCryptoWorker) {
            return await this.decryptBase64WithNativeWorker(data, options);
        }
        return await this.decryptBase64Reference(data);
    }

    private async decryptBase64WithNativeWorker(data: readonly string[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.aes.decrypt',
            { items: data.length, concurrency: this.batchConcurrencyLimit },
            async () => {
                const referenceRun = async () => this.decryptBase64Reference(data);
                if (this.nativeCryptoWorker) {
                    return await decryptAesGcmJsonBase64BatchWithNativeWorker(
                        data,
                        this.secretKey,
                        this.nativeCryptoWorker,
                        referenceRun,
                        { signal: options.signal },
                    );
                }
                return await referenceRun();
            },
        );
    }
}
