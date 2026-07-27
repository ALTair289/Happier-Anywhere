import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const VISIBILITY_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Mechanical guard: navigation visibility is derived in renderer index space.
 * Any DOM measurement here would put a layout read back on the per-scroll-frame
 * path (the pre-unification web observer measured every mounted anchor row with
 * getBoundingClientRect on every frame).
 */
const FORBIDDEN_DOM_MEASUREMENT = [
    'getBoundingClientRect',
    'querySelector',
    'getClientRects',
    'offsetTop',
];

describe('transcript navigation visibility index space', () => {
    it('performs no DOM measurement anywhere in the visibility owner', () => {
        const offenders: string[] = [];
        for (const fileName of readdirSync(VISIBILITY_DIR)) {
            if (!fileName.endsWith('.ts') && !fileName.endsWith('.tsx')) continue;
            if (fileName.endsWith('.test.ts') || fileName.endsWith('.test.tsx')) continue;
            const source = readFileSync(join(VISIBILITY_DIR, fileName), 'utf8');
            for (const token of FORBIDDEN_DOM_MEASUREMENT) {
                if (source.includes(token)) offenders.push(`${fileName}: ${token}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('keeps exactly one anchor-derivation owner in the visibility folder', () => {
        const anchorDerivers = readdirSync(VISIBILITY_DIR).filter((fileName) => (
            !fileName.includes('.test.') &&
            (fileName.includes('VisibleAnchorFacts') || fileName.includes('VisibilityObserver'))
        ));
        expect(anchorDerivers).toEqual([]);
    });
});
