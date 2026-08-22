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

export function resolveVitestOuterShard(env) {
  const raw = String(env?.HAPPIER_UI_VITEST_OUTER_SHARD ?? '').trim();
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

/**
 * How a finished shard terminated.
 *
 * `aborted` is reserved for an OPERATOR interrupt (Ctrl-C, `kill`, a hung-up terminal): the
 * remaining shards would be spawned straight into the same interrupt, so the run stops and
 * says so. Every other termination — a non-zero exit, or a crash signal such as SIGSEGV /
 * SIGABRT / an OOM-killer SIGKILL, which are exactly the failures sharding exists to contain —
 * is that shard's own failure and must NOT hide the shards after it. Stopping there is how a
 * sharded run reported "green" while later shards never executed.
 */
export function classifyVitestShardTermination({ code, signal }) {
  if (signal) {
    const interrupted = signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP';
    return {
      outcome: interrupted ? 'aborted' : 'failed',
      exitCode: resolveSignalExitCode(signal),
      signal,
    };
  }
  if (typeof code === 'number' && code !== 0) {
    return { outcome: 'failed', exitCode: code, signal: null };
  }
  return { outcome: 'passed', exitCode: 0, signal: null };
}

export async function runVitestShardRuns({ shardFiles, runShard }) {
  const outcomes = [];
  let aborted = false;

  for (let index = 0; index < shardFiles.length; index += 1) {
    const shard = index + 1;
    const files = shardFiles[index] ?? [];
    if (files.length === 0) {
      outcomes.push({ outcome: 'empty', shard, fileCount: 0, exitCode: 0, signal: null });
      continue;
    }
    if (aborted) {
      outcomes.push({ outcome: 'unexecuted', shard, fileCount: files.length, exitCode: null, signal: null });
      continue;
    }

    const result = await runShard({ shard, files });
    if (!result.ok) throw result.error;

    const termination = classifyVitestShardTermination(result);
    outcomes.push({ ...termination, shard, fileCount: files.length });
    aborted = termination.outcome === 'aborted';
  }

  return outcomes;
}

export function shouldVitestShardRunProceedWithoutFiles({ fileCount, passthroughArgs }) {
  if (fileCount > 0) return true;
  return Array.from(passthroughArgs ?? []).some((arg) => (
    arg === '--passWithNoTests' || arg === '--passWithNoTests=true'
  ));
}

/**
 * Truthful aggregate for a whole sharded run: what actually ran, what failed, and what never
 * got the chance. The exit code is non-zero whenever any shard failed or the run was aborted.
 */
export function summarizeVitestShardOutcomes({ shardCount, outcomes }) {
  const allOutcomes = Array.from(outcomes ?? []);
  const executed = allOutcomes.filter((entry) => (
    entry.outcome === 'passed' || entry.outcome === 'failed' || entry.outcome === 'aborted'
  ));
  const failedShards = allOutcomes.filter((entry) => entry.outcome === 'failed');
  const abortedShard = allOutcomes.find((entry) => entry.outcome === 'aborted') ?? null;
  const passedCount = allOutcomes.filter((entry) => entry.outcome === 'passed').length;
  const emptyCount = allOutcomes.filter((entry) => entry.outcome === 'empty').length;
  const unexecutedCount = allOutcomes.filter((entry) => entry.outcome === 'unexecuted').length;

  const lines = [];
  if (abortedShard) {
    lines.push(
      `[vitest] run ABORTED by ${abortedShard.signal} at shard ${abortedShard.shard}/${shardCount};`
      + ` shards after it did not run`,
    );
  }
  lines.push(
    `[vitest] ${executed.length} shard(s) ran of ${shardCount}:`
    + ` ${passedCount} passed, ${failedShards.length} failed`
    + (emptyCount > 0 ? `, ${emptyCount} empty` : '')
    + (unexecutedCount > 0 ? `, ${unexecutedCount} unexecuted` : ''),
  );
  for (const entry of failedShards) {
    lines.push(
      `[vitest]   shard ${entry.shard}/${shardCount} FAILED`
      + (entry.signal ? ` (signal ${entry.signal})` : ` (exit ${entry.exitCode})`)
      + ` — ${entry.fileCount} file(s)`,
    );
  }

  const exitCode = abortedShard?.exitCode ?? failedShards[0]?.exitCode ?? 0;
  return {
    exitCode,
    failedShards,
    abortedShard,
    passedCount,
    executedCount: executed.length,
    emptyCount,
    unexecutedCount,
    lines,
  };
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

  const configuredShardCount = resolveVitestShardCount(process.env);
  const outerShard = resolveVitestOuterShard(process.env);
  const shardCount = resolveVitestInnerShardCount(configuredShardCount, outerShard);
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);
  const passthroughArgs = resolveVitestPassthroughArgs(argv);

  const allFiles = await resolveVitestTestFiles({ configPath, nodeOptions, passthroughArgs });
  if (!shouldVitestShardRunProceedWithoutFiles({ fileCount: allFiles.length, passthroughArgs })) {
    // `vitest run` itself exits non-zero when a filter matches nothing. Sharding must not be
    // more permissive than the tool it wraps: a mistyped path filter that silently exits 0 is
    // the same vacuous green as a skipped shard.
    // eslint-disable-next-line no-console
    console.error('[vitest] no test files matched — refusing to report a sharded run as green');
    process.exit(1);
    return;
  }
  const positionalFilters = await resolveVitestPositionalFilters(passthroughArgs);
  const selectedFiles = selectVitestOuterShardFiles(allFiles, outerShard);
  if (outerShard) {
    // eslint-disable-next-line no-console
    console.log(
      `[vitest] outer shard ${outerShard.index}/${outerShard.count}`
      + ` selected ${selectedFiles.length}/${allFiles.length} files`,
    );
  }
  const shardFiles = partitionVitestFilesIntoShards(selectedFiles, shardCount);

  const outcomes = await runVitestShardRuns({
    shardFiles,
    runShard: async ({ shard, files }) => {
      // eslint-disable-next-line no-console
      console.log(`[vitest] shard ${shard}/${shardCount}`);
      return spawnVitestRun({ configPath, nodeOptions, passthroughArgs, positionalFilters, files });
    },
  });

  const summary = summarizeVitestShardOutcomes({ shardCount, outcomes });
  for (const line of summary.lines) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  if (summary.exitCode !== 0) {
    process.exit(summary.exitCode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-void
  void main(process.argv);
}
