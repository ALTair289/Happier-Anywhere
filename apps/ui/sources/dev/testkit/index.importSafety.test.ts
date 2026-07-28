import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/sessions/transcript/viewport/shell/renderer/flashListRenderer', () => {
    throw new Error('The dev testkit barrel evaluated the real FlashList renderer');
});

vi.mock('@/components/sessions/transcript/viewport/shell/renderer/legendListRenderer', () => {
    throw new Error('The dev testkit barrel evaluated the real LegendList renderer');
});

describe('@/dev/testkit import safety', () => {
    it('does not evaluate production transcript renderer modules', async () => {
        await expect(import('@/dev/testkit')).resolves.toBeDefined();
    });
});
