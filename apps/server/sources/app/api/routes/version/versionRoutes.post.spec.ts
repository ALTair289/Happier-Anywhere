import { describe, expect, it, vi } from 'vitest';

import { versionRoutes } from './versionRoutes';

type Handler = (request: { body: unknown }) => Promise<unknown>;

function resolveHandler(): Handler {
    let handler: Handler | undefined;
    const app = {
        get: vi.fn(),
        post: vi.fn((_path: string, _options: unknown, next: Handler) => {
            handler = next;
        }),
    };
    versionRoutes(app as never);
    if (!handler) throw new Error('POST /v1/version handler was not registered');
    return handler;
}

describe('versionRoutes POST /v1/version', () => {
    it('reports current independently from Session protocol capabilities', async () => {
        await expect(resolveHandler()({
            body: {
                v: 1,
                clientKind: 'ui-ios',
                appVersion: '0.2.10',
                appId: 'dev.happier.app',
            },
        })).resolves.toEqual({ v: 1, status: 'current' });
    });

    it('keeps the deployed legacy native request/response shape working', async () => {
        await expect(resolveHandler()({
            body: {
                platform: 'ios',
                version: '0.2.10',
                app_id: 'dev.happier.app',
            },
        })).resolves.toEqual({ update_required: false, update_url: null });
    });
});
