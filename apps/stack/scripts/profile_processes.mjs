#!/usr/bin/env node
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import {
  DEFAULT_CPU_SAMPLE_INTERVAL_MS,
  DEFAULT_PROFILE_DURATION_MS,
  DEFAULT_PROFILE_INTERVAL_MS,
  parseDurationMs,
  parsePositiveInteger,
  resolveProcessTarget,
  runProcessProfile,
} from './profiling/process_profiler.mjs';

function usage() {
  return [
    '[profile-processes] usage:',
    '  hstack tools profile-processes --pid=<pid> [--duration=30s] [--interval=1s] [--out-dir=<dir>] [--label=<name>] [--stack-sample=10s] [--memory-map] [--json]',
    '  hstack tools profile-processes --command-match=<unique substring> [same options]',
    '  hstack tools profile-processes --pid=<pid> --dry-run [--json]',
    '',
    'Notes:',
    '  - Default output dir is the host temp directory, not the repository.',
    '  - Memory output is RSS/VSZ sampling plus an optional post-sampling vmmap summary; RSS growth is not reported as a confirmed leak.',
    '  - CPU stack profiling uses macOS sample only when --stack-sample or --cpu-profile is provided.',
  ].join('\n');
}

function readValue(kv, ...names) {
  for (const name of names) {
    if (kv.has(name)) return kv.get(name);
  }
  return null;
}

function textSummary(result) {
  const memory = result.summary.memory;
  const cpu = result.summary.cpu;
  const lines = [
    `[profile-processes] pid ${result.target.pid} sampled ${result.summary.sampleCount} times over ${result.summary.durationMs}ms`,
    `[profile-processes] CPU avg ${cpu.averagePercent}% max ${cpu.maxPercent}%`,
    `[profile-processes] RSS start ${memory.rssStartBytes} B, end ${memory.rssEndBytes} B, delta ${memory.rssDeltaBytes} B, growth/min ${memory.rssGrowthPerMinuteBytes} B`,
    `[profile-processes] samples: ${result.artifacts.samples}`,
    `[profile-processes] summary: ${result.artifacts.summary}`,
  ];
  if (result.cpuProfile) {
    lines.push(
      result.cpuProfile.ok
        ? `[profile-processes] cpu sample: ${result.cpuProfile.file}`
        : `[profile-processes] cpu sample failed: ${result.cpuProfile.error ?? result.cpuProfile.stderr ?? 'unknown error'}`,
    );
  }
  if (result.memoryMaps) {
    lines.push(`[profile-processes] vmmap summary: ${result.artifacts.vmmapEnd}`);
  }
  return lines.join('\n');
}

export async function runProfileProcessesCli(argv = process.argv.slice(2)) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { usage: usage() }, text: usage() });
    return;
  }

  const pidRaw = readValue(kv, '--pid');
  const commandMatch = readValue(kv, '--command-match');
  const targetInput = {
    pid: pidRaw == null ? null : parsePositiveInteger(pidRaw, 'pid'),
    commandMatch,
  };

  const durationMs = parseDurationMs(readValue(kv, '--duration', '--duration-ms'), 'duration') ?? DEFAULT_PROFILE_DURATION_MS;
  const intervalMs = parseDurationMs(readValue(kv, '--interval', '--interval-ms'), 'interval') ?? DEFAULT_PROFILE_INTERVAL_MS;
  const cpuProfileMs =
    parseDurationMs(readValue(kv, '--stack-sample', '--stack-sample-ms', '--cpu-profile', '--cpu-profile-ms'), 'stack-sample') ?? 0;
  const sampleIntervalMs =
    readValue(kv, '--sample-interval', '--sample-interval-ms') == null
      ? DEFAULT_CPU_SAMPLE_INTERVAL_MS
      : parsePositiveInteger(readValue(kv, '--sample-interval', '--sample-interval-ms'), 'sample-interval');
  const outputDir = readValue(kv, '--out-dir') ?? join(tmpdir(), 'happier-process-profiles');
  const label = readValue(kv, '--label') ?? (targetInput.commandMatch ? targetInput.commandMatch : null);
  const memoryMap = flags.has('--memory-map');
  const dryRun = flags.has('--dry-run') || flags.has('--print-plan');

  if (dryRun) {
    const target = await resolveProcessTarget(targetInput);
    const plan = {
      target,
      outputDir,
      parameters: { durationMs, intervalMs, cpuProfileMs, sampleIntervalMs, memoryMap },
    };
    printResult({
      json,
      data: plan,
      text: [
        `[profile-processes] target pid: ${target.pid}`,
        `[profile-processes] output dir: ${outputDir}`,
        `[profile-processes] duration: ${durationMs}ms; interval: ${intervalMs}ms`,
        cpuProfileMs ? `[profile-processes] cpu sample: ${cpuProfileMs}ms @ ${sampleIntervalMs}ms` : '[profile-processes] cpu sample: disabled',
        memoryMap ? '[profile-processes] vmmap summary: enabled' : '[profile-processes] vmmap summary: disabled',
      ].join('\n'),
    });
    return;
  }

  const result = await runProcessProfile({
    ...targetInput,
    label,
    outputDir,
    durationMs,
    intervalMs,
    cpuProfileMs,
    sampleIntervalMs,
    memoryMap,
  });

  printResult({ json, data: result, text: textSummary(result) });

  if (result.cpuProfile && !result.cpuProfile.ok) {
    process.exitCode = 1;
  }
  if (result.memoryMaps && [result.memoryMaps.start, result.memoryMaps.end].some((entry) => entry && !entry.ok)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProfileProcessesCli().catch((err) => {
    console.error('[profile-processes] failed:', err);
    process.exit(1);
  });
}
