#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveSignalExitCode, runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import { resolveMaxOldSpaceSizeMb, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';

function parsePositiveInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveVitestShardCount(env) {
  const override = parsePositiveInt(env?.HAPPIER_CLI_VITEST_SHARDS);
  return override ?? 8;
}

export function resolveVitestMaxWorkers(env) {
  const override = parsePositiveInt(env?.HAPPIER_CLI_VITEST_MAX_WORKERS);
  return override ?? 1;
}

export function resolveVitestOuterShard(env) {
  const raw = String(env?.HAPPIER_CLI_VITEST_OUTER_SHARD ?? '').trim();
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (!match) return null;

  const index = Number.parseInt(match[1], 10);
  const count = Number.parseInt(match[2], 10);
  if (index < 1 || count < 1 || index > count) return null;
  return { index, count };
}

export function selectVitestOuterShardFiles(files, outerShard) {
  if (!outerShard) return Array.from(files ?? []);
  return partitionVitestFilesIntoShards(files, outerShard.count)[outerShard.index - 1] ?? [];
}

export function resolveVitestInnerShardCount(configuredShardCount, outerShard) {
  if (!outerShard) return configuredShardCount;
  return Math.max(1, Math.ceil(configuredShardCount / outerShard.count));
}

export function resolveVitestConfigPath(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseVitestListJson(raw) {
  const parsed = JSON.parse(String(raw ?? 'null'));
  if (!Array.isArray(parsed)) {
    throw new Error('[runVitestShards] vitest list --json output must be an array');
  }

  return parsed
    .map((entry) => (entry && typeof entry.file === 'string' ? entry.file : null))
    .filter((file) => typeof file === 'string' && file.trim().length > 0);
}

export function partitionVitestFilesIntoShards(files, shardCount) {
  const count = Number.isFinite(shardCount) && shardCount > 0 ? Math.floor(shardCount) : 1;
  const buckets = Array.from({ length: count }, () => []);
  const sortedFiles = Array.from(files ?? []).filter(Boolean).sort();
  for (let index = 0; index < sortedFiles.length; index += 1) {
    buckets[index % count].push(sortedFiles[index]);
  }
  return buckets;
}

export function buildVitestShardRunArgs({ configPath, files, maxWorkers = 1 }) {
  const schedulingArgs = maxWorkers > 1
    ? [`--maxWorkers=${maxWorkers}`]
    : ['--no-file-parallelism'];
  return ['run', '--config', configPath, ...schedulingArgs, ...(files ?? [])];
}

async function resolveVitestTestFiles({ configPath, nodeOptions }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-cli-vitest-list-'));
  const jsonPath = path.join(tmpDir, 'vitest-files.json');

  const result = await runManagedChildCommand({
    command: 'vitest',
    args: ['list', '--config', configPath, '--filesOnly', '--json', jsonPath],
    spawnOptions: {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
  });

  if (!result.ok) {
    throw result.error;
  }
  if (result.signal) {
    process.exit(resolveSignalExitCode(result.signal));
    return [];
  }
  if (result.code && result.code !== 0) {
    process.exit(result.code);
    return [];
  }

  try {
    return parseVitestListJson(await fs.readFile(jsonPath, 'utf8'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {});
  }
}

function spawnVitestRun({ configPath, files, maxWorkers, nodeOptions }) {
  return runManagedChildCommand({
    command: 'vitest',
    args: buildVitestShardRunArgs({ configPath, files, maxWorkers }),
    spawnOptions: {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
  });
}

async function main(argv) {
  const configPath = resolveVitestConfigPath(argv);
  if (!configPath) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/runVitestShards.mjs --config <vitest.config.ts>');
    process.exit(1);
  }

  const configuredShardCount = resolveVitestShardCount(process.env);
  const outerShard = resolveVitestOuterShard(process.env);
  const shardCount = resolveVitestInnerShardCount(configuredShardCount, outerShard);
  const maxWorkers = resolveVitestMaxWorkers(process.env);
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);
  const allFiles = await resolveVitestTestFiles({ configPath, nodeOptions });
  const selectedFiles = selectVitestOuterShardFiles(allFiles, outerShard);
  if (selectedFiles.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[vitest] no test files matched — refusing to report a sharded run as green');
    process.exit(1);
    return;
  }
  if (outerShard) {
    // eslint-disable-next-line no-console
    console.log(
      `[vitest] outer shard ${outerShard.index}/${outerShard.count}`
      + ` selected ${selectedFiles.length}/${allFiles.length} files`,
    );
  }
  const shardFiles = partitionVitestFilesIntoShards(selectedFiles, shardCount);

  let failedShardCount = 0;
  let firstFailureExitCode = 0;
  for (let index = 1; index <= shardCount; index += 1) {
    const files = shardFiles[index - 1] ?? [];
    if (files.length === 0) continue;
    // eslint-disable-next-line no-console
    console.log(`[vitest] shard ${index}/${shardCount} (${files.length} files)`);
    const result = await spawnVitestRun({ configPath, files, maxWorkers, nodeOptions });
    if (!result.ok) {
      throw result.error;
    }
    if (result.signal) {
      process.exit(resolveSignalExitCode(result.signal));
      return;
    }
    if (result.code && result.code !== 0) {
      failedShardCount += 1;
      firstFailureExitCode ||= result.code;
      // eslint-disable-next-line no-console
      console.error(`[vitest] shard ${index}/${shardCount} failed with exit ${result.code}; continuing`);
    }
  }

  if (failedShardCount > 0) {
    // eslint-disable-next-line no-console
    console.error(`[vitest] ${failedShardCount}/${shardCount} shard(s) failed`);
    process.exit(firstFailureExitCode || 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-void
  void main(process.argv);
}
