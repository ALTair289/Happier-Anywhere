import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES_DIR = join(__dirname, '..', '..', '..');

/**
 * Bans `cond ? 'glyph' : 'glyph'` — a conditional whose arms are the same glyph.
 *
 * This is not a style nit. Under Ionicons, fill was encoded in the NAME, so a toggle was written
 * `isFavorite ? 'star' : 'star-outline'` and the two arms were the entire visual difference between
 * on and off. The Phosphor migration mapped both spellings onto one glyph, which silently turned
 * every one of those into `isFavorite ? 'star' : 'star'` — sixteen toggles across fifteen files,
 * six of which were left with no way at all to tell their two states apart.
 *
 * A self-identical ternary is the fingerprint of exactly that: a state distinction the author
 * deliberately wrote, now collapsed. Keeping it out means the collapse cannot happen quietly again.
 */
function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\./.test(entry)) out.push(full);
    }
    return out;
}

describe('icon state ternaries', () => {
    it('never resolves both arms to the same glyph', () => {
        const offenders: string[] = [];

        for (const file of walk(SOURCES_DIR)) {
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(/\?\s*'([a-z][a-z0-9-]*)'\s*:\s*'([a-z][a-z0-9-]*)'/g)) {
                if (match[1] !== match[2]) continue;
                // Only flag values that name a real glyph — plenty of domain ternaries are unrelated.
                const line = source.slice(0, match.index).split('\n').length;
                const context = source.split('\n').slice(Math.max(0, line - 4), line + 1).join('\n');
                if (!/\b(name|icon|iconName|glyph)\b/i.test(context)) continue;
                offenders.push(`${file.replace(SOURCES_DIR, '')}:${line} — ${match[1]} on both arms`);
            }
        }

        expect(offenders.sort()).toEqual([]);
    });
});
