import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const TRANSCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));

function listTranscriptModuleFiles(dir: string, relative: string): readonly string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
            return listTranscriptModuleFiles(`${dir}${entry.name}/`, `${relative}${entry.name}/`);
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) return [];
        if (entry.name.includes('.test.')) return [];
        return [`${relative}${entry.name}`];
    });
}

function readCodeLines(relativePath: string): readonly string[] {
    return readFileSync(`${TRANSCRIPT_DIR}${relativePath}`, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*'));
}

/**
 * A module whose entire body is `export * from '<other module>'` gives one owner two
 * resolvable specifiers. Consumers then split across both, and a `vi.mock` of either
 * specifier silently leaves the consumers of the other one running the real code — a
 * false green that looks like coverage. The transcript corridor had four of these
 * (2026-07-27 audit, E-16), so the owning module must stay the only way to reach it.
 */
describe('transcript module path uniqueness', () => {
    it('has no alias module that re-exports another transcript module wholesale', () => {
        const aliasModules = listTranscriptModuleFiles(TRANSCRIPT_DIR, '')
            .filter((relativePath) => {
                const lines = readCodeLines(relativePath);
                return lines.length > 0 && lines.every((line) => /^export \* from ['"]/.test(line));
            })
            .sort();

        expect(aliasModules).toEqual([]);
    });
});
