import { describe, expect, it } from 'vitest';

import {
  buildVitestShardRunArgs,
  parseVitestListJson,
  partitionVitestFilesIntoShards,
  resolveVitestConfigPath,
  resolveVitestMaxWorkers,
  resolveVitestShardCount,
} from '../runVitestShards.mjs';

describe('runVitestShards', () => {
  it('defaults shard count to 8', () => {
    expect(resolveVitestShardCount({})).toBe(8);
  });

  it('uses HAPPIER_CLI_VITEST_SHARDS override when valid', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '4' })).toBe(4);
  });

  it('ignores invalid shard overrides', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '0' })).toBe(8);
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: 'nope' })).toBe(8);
  });

  it('parses --config path from argv', () => {
    expect(resolveVitestConfigPath(['node', 'run', '--config', 'vitest.integration.config.ts'])).toBe(
      'vitest.integration.config.ts',
    );
  });

  it('returns null when --config is missing', () => {
    expect(resolveVitestConfigPath(['node', 'run'])).toBe(null);
  });

  it('uses one worker by default and accepts a bounded worker override', () => {
    expect(resolveVitestMaxWorkers({})).toBe(1);
    expect(resolveVitestMaxWorkers({ HAPPIER_CLI_VITEST_MAX_WORKERS: '2' })).toBe(2);
    expect(resolveVitestMaxWorkers({ HAPPIER_CLI_VITEST_MAX_WORKERS: '0' })).toBe(1);
  });

  it('parses Vitest file-list JSON without retaining unrelated fields', () => {
    expect(parseVitestListJson(JSON.stringify([
      { file: '/repo/src/b.test.ts', projectName: '' },
      { file: '/repo/src/a.test.ts', projectName: '' },
      { projectName: 'missing-file' },
    ]))).toEqual(['/repo/src/b.test.ts', '/repo/src/a.test.ts']);
  });

  it('partitions explicit files deterministically across bounded processes', () => {
    expect(partitionVitestFilesIntoShards(['d', 'b', 'a', 'c'], 2)).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ]);
  });

  it('runs only the explicit files assigned to a shard', () => {
    expect(buildVitestShardRunArgs({
      configPath: 'vitest.config.ts',
      files: ['/repo/src/a.test.ts', '/repo/src/b.test.ts'],
    })).toEqual([
      'run',
      '--config',
      'vitest.config.ts',
      '--no-file-parallelism',
      '/repo/src/a.test.ts',
      '/repo/src/b.test.ts',
    ]);
  });

  it('caps file-level parallelism when a shard opts into multiple workers', () => {
    expect(buildVitestShardRunArgs({
      configPath: 'vitest.config.ts',
      files: ['/repo/src/a.test.ts'],
      maxWorkers: 2,
    })).toEqual([
      'run',
      '--config',
      'vitest.config.ts',
      '--maxWorkers=2',
      '/repo/src/a.test.ts',
    ]);
  });
});

