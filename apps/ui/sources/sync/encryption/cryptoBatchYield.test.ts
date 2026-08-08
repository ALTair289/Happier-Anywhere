import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE,
    mapCryptoBatchWithYield,
} from './cryptoBatchYield';

describe('mapCryptoBatchWithYield', () => {
    it('produces exactly the results of a synchronous map, in order', async () => {
        const items = Array.from({ length: 101 }, (_, index) => index);
        const mapItem = (item: number, index: number) => `${item}:${index}`;

        await expect(mapCryptoBatchWithYield(items, mapItem, { chunkSize: 8 }))
            .resolves.toEqual(items.map(mapItem));
    });

    it('runs a batch that fits in one chunk without releasing the thread', async () => {
        const yieldBetweenChunks = vi.fn(async () => {});

        await mapCryptoBatchWithYield([1, 2, 3], (item) => item * 2, {
            chunkSize: 3,
            yieldBetweenChunks,
        });

        expect(yieldBetweenChunks).not.toHaveBeenCalled();
    });

    it('releases the thread between chunks and never before processing has started', async () => {
        const processedBeforeEachYield: number[] = [];
        let processed = 0;
        const yieldBetweenChunks = vi.fn(async () => {
            processedBeforeEachYield.push(processed);
        });

        await mapCryptoBatchWithYield(Array.from({ length: 10 }, (_, index) => index), (item) => {
            processed += 1;
            return item;
        }, { chunkSize: 4, yieldBetweenChunks });

        expect(processedBeforeEachYield).toEqual([4, 8]);
    });

    it('lets pending timers run while a large batch is in flight', async () => {
        let ticks = 0;
        const interval = setInterval(() => {
            ticks += 1;
        }, 0);
        try {
            await mapCryptoBatchWithYield(
                Array.from({ length: DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE * 3 }, (_, index) => index),
                (item) => item,
            );
        } finally {
            clearInterval(interval);
        }

        expect(ticks).toBeGreaterThan(0);
    });

    it('falls back to the default chunk size for unusable inputs', async () => {
        const yieldBetweenChunks = vi.fn(async () => {});
        const items = Array.from({ length: DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE + 1 }, (_, index) => index);

        await mapCryptoBatchWithYield(items, (item) => item, {
            chunkSize: Number.NaN,
            yieldBetweenChunks,
        });

        expect(yieldBetweenChunks).toHaveBeenCalledTimes(1);
    });
});
