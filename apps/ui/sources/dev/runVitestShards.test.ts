import { describe, expect, it } from 'vitest';

import {
    buildVitestShardRunArgs,
    partitionVitestFilesIntoShards,
    resolveVitestConfigPath,
    resolveVitestPositionalFilters,
    resolveVitestShardCount,
    resolveVitestPassthroughArgs,
} from '../../scripts/runVitestShards.mjs';

describe('apps/ui runVitestShards', () => {
    it('defaults shard count to 24', () => {
        expect(resolveVitestShardCount({})).toBe(24);
    });

    it('uses HAPPIER_UI_VITEST_SHARDS override when valid', () => {
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: '6' })).toBe(6);
    });

    it('ignores invalid shard overrides', () => {
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: '0' })).toBe(24);
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: 'nope' })).toBe(24);
    });

    it('parses --config path from argv', () => {
        expect(resolveVitestConfigPath(['node', 'run', '--config', 'vitest.config.ts'])).toBe(
            'vitest.config.ts',
        );
    });

    it('returns null when --config is missing', () => {
        expect(resolveVitestConfigPath(['node', 'run'])).toBe(null);
    });

    it('preserves additional vitest args after --config', () => {
        expect(
            resolveVitestPassthroughArgs([
                'node',
                'run',
                '--config',
                'vitest.config.ts',
                'sources/dev/runVitestShards.test.ts',
                '--reporter',
                'dot',
            ]),
        ).toEqual(['sources/dev/runVitestShards.test.ts', '--reporter', 'dot']);
    });

    it('partitions files across shards deterministically', () => {
        const buckets = partitionVitestFilesIntoShards(['c', 'a', 'b', 'd', 'e'], 2);
        expect(buckets).toEqual([
            ['a', 'c', 'e'],
            ['b', 'd'],
        ]);
    });

    it('partitions every file exactly once even when shards outnumber files', () => {
        const files = ['e', 'a', 'd', 'b', 'c'];
        const executed = partitionVitestFilesIntoShards(files, 8).flat();
        // No file may be dropped and none may be executed twice.
        expect(executed.slice().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(executed).toHaveLength(files.length);
    });

    it('runs a shard on its own file list without re-adding the caller path filters', () => {
        // Vitest ORs positional filters, so forwarding the caller filter alongside the
        // shard file list makes every shard re-run the whole filtered set.
        expect(
            buildVitestShardRunArgs({
                configPath: 'vitest.config.ts',
                passthroughArgs: ['sources/components/sessions', '--reporter', 'dot'],
                positionalFilters: ['sources/components/sessions'],
                files: ['/abs/a.test.ts', '/abs/b.test.ts'],
            }),
        ).toEqual([
            'run',
            '--config',
            'vitest.config.ts',
            '--no-file-parallelism',
            '--reporter',
            'dot',
            '/abs/a.test.ts',
            '/abs/b.test.ts',
        ]);
    });

    it('leaves an unfiltered run (the CI lane shape) carrying only its shard files', () => {
        expect(
            buildVitestShardRunArgs({
                configPath: 'vitest.config.ts',
                passthroughArgs: [],
                positionalFilters: [],
                files: ['/abs/a.test.ts'],
            }),
        ).toEqual(['run', '--config', 'vitest.config.ts', '--no-file-parallelism', '/abs/a.test.ts']);
    });

    it('keeps an option value that is spelled like the dropped path filter', () => {
        expect(
            buildVitestShardRunArgs({
                configPath: 'vitest.config.ts',
                passthroughArgs: ['--testNamePattern', 'sources/x', 'sources/x'],
                positionalFilters: ['sources/x'],
                files: ['/abs/a.test.ts'],
            }),
        ).toEqual([
            'run',
            '--config',
            'vitest.config.ts',
            '--no-file-parallelism',
            '--testNamePattern',
            'sources/x',
            '/abs/a.test.ts',
        ]);
    });

    it('classifies positional filters with vitest own CLI parser, not a dash heuristic', async () => {
        await expect(
            resolveVitestPositionalFilters(['--reporter', 'dot', 'sources/a', 'sources/b']),
        ).resolves.toEqual(['sources/a', 'sources/b']);
        // `1` is the value of `--bail`, not a path filter.
        await expect(resolveVitestPositionalFilters(['--bail', '1', 'sources/a'])).resolves.toEqual([
            'sources/a',
        ]);
        await expect(resolveVitestPositionalFilters([])).resolves.toEqual([]);
    });
});
