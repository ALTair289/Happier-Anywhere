#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { resolveSignalExitCode, runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import { resolveMaxOldSpaceSizeMb, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';

function parsePositiveInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveVitestShardCount(env) {
  const override = parsePositiveInt(env?.HAPPIER_UI_VITEST_SHARDS);
  // The UI suite has a large module graph (React Native stubs + Expo/web shims).
  // Running too many files in a single Vitest process can cause heap growth over time,
  // even with `isolate: true`. More shards keeps each process smaller and avoids OOMs.
  return override ?? 24;
}

export function resolveVitestConfigPath(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveVitestPassthroughArgs(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return argv.slice(2);
  return argv.slice(idx + 2);
}

function parseVitestListJson(raw) {
  const parsed = JSON.parse(String(raw ?? 'null'));
  if (!Array.isArray(parsed)) {
    throw new Error('[runVitestShards] vitest list --json output must be an array');
  }

  return parsed
    .map((entry) => (entry && typeof entry.file === 'string' ? entry.file : null))
    .filter((file) => typeof file === 'string' && file.trim().length > 0);
}

/**
 * Vitest ORs positional filters: a shard invocation that carries both the caller's path
 * filter and the shard's file list re-runs the whole filtered set. The shard file list is
 * already the resolved form of those filters, so the filters must be dropped from the
 * per-shard run. Classification uses Vitest's own CLI parser rather than a local option
 * table so that option values (`--bail 1`) are never mistaken for path filters.
 */
export async function resolveVitestPositionalFilters(passthroughArgs) {
  const args = Array.from(passthroughArgs ?? []);
  if (args.length === 0) return [];

  const { parseCLI } = await import('vitest/node');
  // parseCLI mutates the argv it is given, so hand it a throwaway array.
  const { filter } = parseCLI(['vitest', 'run', ...args]);
  return Array.isArray(filter) ? Array.from(filter) : [];
}

export function buildVitestShardRunArgs({ configPath, passthroughArgs, positionalFilters, files }) {
  const droppable = new Map();
  for (const filter of positionalFilters ?? []) {
    droppable.set(filter, (droppable.get(filter) ?? 0) + 1);
  }

  const optionArgs = [];
  for (const arg of passthroughArgs ?? []) {
    const remaining = droppable.get(arg) ?? 0;
    if (remaining > 0) {
      droppable.set(arg, remaining - 1);
      continue;
    }
    optionArgs.push(arg);
  }

  return [
    'run',
    '--config',
    configPath,
    '--no-file-parallelism',
    ...optionArgs,
    ...(files ?? []),
  ];
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

async function resolveVitestTestFiles({ configPath, nodeOptions, passthroughArgs }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-ui-vitest-list-'));
  const jsonPath = path.join(tmpDir, 'vitest-files.json');

  const result = await runManagedChildCommand({
    command: 'vitest',
    args: [
      'list',
      '--config',
      configPath,
      '--filesOnly',
      '--json',
      jsonPath,
      ...passthroughArgs,
    ],
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
    const raw = await fs.readFile(jsonPath, 'utf8');
    return parseVitestListJson(raw);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {});
  }
}

function spawnVitestRun({ configPath, nodeOptions, passthroughArgs, positionalFilters, files }) {
  return runManagedChildCommand({
    command: 'vitest',
    args: buildVitestShardRunArgs({ configPath, passthroughArgs, positionalFilters, files }),
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

  const shardCount = resolveVitestShardCount(process.env);
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);
  const passthroughArgs = resolveVitestPassthroughArgs(argv);

  const allFiles = await resolveVitestTestFiles({ configPath, nodeOptions, passthroughArgs });
  const positionalFilters = await resolveVitestPositionalFilters(passthroughArgs);
  const shardFiles = partitionVitestFilesIntoShards(allFiles, shardCount);

  for (let index = 1; index <= shardCount; index += 1) {
    const files = shardFiles[index - 1] ?? [];
    if (files.length === 0) continue;
    // eslint-disable-next-line no-console
    console.log(`[vitest] shard ${index}/${shardCount}`);
    const result = await spawnVitestRun({ configPath, nodeOptions, passthroughArgs, positionalFilters, files });
    if (!result.ok) {
      throw result.error;
    }
    if (result.signal) {
      process.exit(resolveSignalExitCode(result.signal));
      return;
    }
    if (result.code && result.code !== 0) {
      process.exit(result.code);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-void
  void main(process.argv);
}
