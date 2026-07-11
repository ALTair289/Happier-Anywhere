import { describe, expect, it, vi } from 'vitest';

import { getRandomBytes } from '@/platform/cryptoRandom';
import { stringifySerializedJsonValue } from '@happier-dev/protocol';

import { AES256Encryption, BoxEncryption, SecretBoxEncryption } from './encryptor';

describe('encryptor top-level undefined handling', () => {
    it('preserves undefined for secret-box encryption', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));

        const encrypted = await encryptor.encrypt([undefined]);
        const decrypted = await encryptor.decrypt(encrypted);

        expect(decrypted).toEqual([undefined]);
    });

    it('preserves undefined for box encryption', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));

        const encrypted = await encryptor.encrypt([undefined]);
        const decrypted = await encryptor.decrypt(encrypted);

        expect(decrypted).toEqual([undefined]);
    });

    it('preserves undefined for aes-256 encryption', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));

        const encrypted = await encryptor.encrypt([undefined]);
        const decrypted = await encryptor.decrypt(encrypted);

        expect(decrypted).toEqual([undefined]);
    });

    it('routes large AES base64 payloads through the web JSON decrypt worker', async () => {
        const workerRequests: unknown[] = [];
        const fakeWorker = {
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            postMessage(message: any) {
                workerRequests.push(message);
                queueMicrotask(() => {
                    this.onmessage?.({
                        data: {
                            id: message.id,
                            status: 'ok',
                            items: [{ role: 'user', content: { type: 'text', text: 'worker' } }],
                        },
                    });
                });
            },
            terminate() {},
        };
        const encryptor = new AES256Encryption(getRandomBytes(32), {
            decryptString: async () => {
                throw new Error('large web payload should not decrypt or parse on the JS thread');
            },
            webJsonDecryptWorker: {
                largePayloadThresholdBytes: 1,
                workerFactory: () => fakeWorker as unknown as Worker,
            },
        });

        const decryptBase64 = encryptor.decryptBase64;
        expect(typeof decryptBase64).toBe('function');
        await expect(decryptBase64?.(['AAECAwQFBgcICQoLDA0ODw=='])).resolves.toEqual([
            { role: 'user', content: { type: 'text', text: 'worker' } },
        ]);
        expect(workerRequests).toHaveLength(1);
    });

    it('preserves top-level undefined returned by the web JSON decrypt worker', async () => {
        const fakeWorker = {
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            postMessage(message: any) {
                queueMicrotask(() => {
                    this.onmessage?.({
                        data: {
                            id: message.id,
                            status: 'ok',
                            items: [undefined],
                        },
                    });
                });
            },
            terminate() {},
        };
        const encryptor = new AES256Encryption(getRandomBytes(32), {
            decryptString: async () => {
                throw new Error('large web payload should not fall back to JS decrypt');
            },
            webJsonDecryptWorker: {
                largePayloadThresholdBytes: 1,
                workerFactory: () => fakeWorker as unknown as Worker,
            },
        });

        await expect(encryptor.decryptBase64?.(['AAECAwQFBgcICQoLDA0ODw=='])).resolves.toEqual([undefined]);
    });

    it('keeps small AES base64 payloads on the reference decrypt path', async () => {
        const decryptString = vi.fn(async () => stringifySerializedJsonValue({ value: 'small' }));
        const encryptor = new AES256Encryption(getRandomBytes(32), {
            decryptString,
            webJsonDecryptWorker: {
                largePayloadThresholdBytes: 1024 * 1024,
                workerFactory: () => {
                    throw new Error('small payload should not create a worker');
                },
            },
        });

        await expect(encryptor.decryptBase64?.(['AAECAwQ='])).resolves.toEqual([{ value: 'small' }]);
        expect(decryptString).toHaveBeenCalledTimes(1);
    });

    it('yields between large AES payloads when worker offload is unavailable', async () => {
        const decryptString = vi.fn(async (_payload: string) => stringifySerializedJsonValue({ value: 'fallback' }));
        const yieldBetweenLargePayloads = vi.fn(async () => {});
        const encryptor = new AES256Encryption(getRandomBytes(32), {
            decryptString,
            largePayloadYieldBytes: 1,
            yieldBetweenLargePayloadDecrypts: yieldBetweenLargePayloads,
            webJsonDecryptWorker: {
                largePayloadThresholdBytes: 1,
                workerFactory: () => {
                    throw new Error('worker unavailable');
                },
            },
        });

        await expect(encryptor.decryptBase64?.(['AAECAwQ=', 'AAUGBwg='])).resolves.toEqual([
            { value: 'fallback' },
            { value: 'fallback' },
        ]);
        expect(yieldBetweenLargePayloads).toHaveBeenCalledTimes(1);
    });
});
