import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWebFontFaces } from './installWebFontFaces';

describe('installWebFontFaces', () => {
    afterEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as { document?: Document }).document;
    });

    it('settles only after every injected font family load settles', async () => {
        const loadResolvers: Array<() => void> = [];
        const load = vi.fn(() => new Promise<FontFace[]>((resolve) => {
            loadResolvers.push(() => resolve([]));
        }));
        const appendChild = vi.fn();
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: {
                createElement: vi.fn(() => ({ id: '', textContent: '' })),
                fonts: { load },
                getElementById: vi.fn(() => null),
                head: { appendChild },
            },
        });

        let settled = false;
        const installation = installWebFontFaces({
            'Inter-Regular': { uri: 'https://example.test/inter.woff2' },
            'IBMPlexMono-Regular': { uri: 'https://example.test/ibm-plex-mono.woff2' },
        }).then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(load).toHaveBeenCalledTimes(2);
        expect(settled).toBe(false);

        loadResolvers[0]?.();
        await Promise.resolve();
        expect(settled).toBe(false);

        loadResolvers[1]?.();
        await installation;

        expect(settled).toBe(true);
        expect(appendChild).toHaveBeenCalledTimes(1);
    });
});
