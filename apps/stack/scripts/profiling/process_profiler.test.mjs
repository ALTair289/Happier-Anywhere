import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildShellCommand,
  parseProcessMetrics,
  resolveProcessTarget,
  runProcessProfile,
  summarizeProcessSamples,
} from './process_profiler.mjs';

test('buildShellCommand quotes profiler command arguments for bash fallback', () => {
  assert.equal(
    buildShellCommand('ps', ['-p', '12', '--label', "canary's process"]),
    "'ps' '-p' '12' '--label' 'canary'\\''s process'",
  );
});

test('resolveProcessTarget fails closed when a command match is ambiguous', async () => {
  await assert.rejects(
    () =>
      resolveProcessTarget({
        commandMatch: 'Happier',
        listProcesses: async () => [
          { pid: 101, command: '/tmp/Happierinternaldev.app/Happierinternaldev' },
          { pid: 202, command: '/tmp/Other.app/HappierPreview' },
        ],
      }),
    /matched 2 processes/,
  );
});

test('parseProcessMetrics normalizes ps cpu and memory fields', () => {
  const sample = parseProcessMetrics(' 67164  12.5  204800  409600  01:02.34 /App/Happierinternaldev --flag\n');

  assert.deepEqual(sample, {
    pid: 67164,
    cpuPercent: 12.5,
    rssBytes: 209715200,
    rssKb: 204800,
    vszBytes: 419430400,
    vszKb: 409600,
    elapsed: '01:02.34',
    command: '/App/Happierinternaldev --flag',
  });
});

test('summarizeProcessSamples reports RSS growth and CPU bounds from facts only', () => {
  const summary = summarizeProcessSamples([
    { elapsedMs: 0, cpuPercent: 5, rssBytes: 100 * 1024 * 1024 },
    { elapsedMs: 1_000, cpuPercent: 15, rssBytes: 115 * 1024 * 1024 },
    { elapsedMs: 2_000, cpuPercent: 10, rssBytes: 130 * 1024 * 1024 },
  ]);

  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.durationMs, 2_000);
  assert.equal(summary.cpu.averagePercent, 10);
  assert.equal(summary.cpu.maxPercent, 15);
  assert.equal(summary.memory.rssStartBytes, 104857600);
  assert.equal(summary.memory.rssEndBytes, 136314880);
  assert.equal(summary.memory.rssDeltaBytes, 31457280);
  assert.equal(summary.memory.rssGrowthPerMinuteBytes, 943718400);
});

test('runProcessProfile writes NDJSON samples, summary, and optional cpu stack sample artifact', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'happier-process-profile-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  });

  const cpuProfileCalls = [];
  const result = await runProcessProfile({
    pid: 67164,
    label: 'ios-session-list',
    outputDir,
    durationMs: 2_000,
    intervalMs: 1_000,
    cpuProfileMs: 1_000,
    sampleIntervalMs: 10,
    now: (() => {
      let value = 1_000_000;
      return () => value;
    })(),
    sleep: async () => {},
    sampleProcess: async (_pid, { sampleIndex }) => ({
      pid: 67164,
      cpuPercent: [4, 8, 6][sampleIndex],
      rssBytes: [200, 215, 230][sampleIndex] * 1024 * 1024,
      rssKb: [200, 215, 230][sampleIndex] * 1024,
      vszBytes: 500 * 1024 * 1024,
      vszKb: 500 * 1024,
      elapsed: `00:0${sampleIndex}`,
      command: '/App/Happierinternaldev',
    }),
    runCpuStackSample: async (pid, options) => {
      cpuProfileCalls.push({ pid, options });
      return { ok: true, file: options.outputFile };
    },
  });

  assert.equal(result.target.pid, 67164);
  assert.equal(result.summary.sampleCount, 3);
  assert.equal(result.summary.memory.rssDeltaBytes, 30 * 1024 * 1024);
  assert.equal(cpuProfileCalls.length, 1);
  assert.equal(cpuProfileCalls[0].pid, 67164);
  assert.equal(cpuProfileCalls[0].options.durationMs, 1_000);
  assert.equal(cpuProfileCalls[0].options.sampleIntervalMs, 10);

  const samplesText = await readFile(result.artifacts.samples, 'utf-8');
  const samples = samplesText.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(samples.length, 3);
  assert.equal(samples[0].rssBytes, 200 * 1024 * 1024);

  const summary = JSON.parse(await readFile(result.artifacts.summary, 'utf-8'));
  assert.equal(summary.label, 'ios-session-list');
  assert.equal(summary.summary.cpu.maxPercent, 8);
});

test('runProcessProfile captures start and end memory maps when requested', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'happier-process-profile-memory-map-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  });

  const memoryMapCalls = [];
  const result = await runProcessProfile({
    pid: 67164,
    label: 'ios-memory-map',
    outputDir,
    durationMs: 1_000,
    intervalMs: 1_000,
    memoryMap: true,
    now: () => 1_000_000,
    sleep: async () => {},
    sampleProcess: async (_pid, { sampleIndex }) => ({
      pid: 67164,
      cpuPercent: sampleIndex,
      rssBytes: (200 + sampleIndex) * 1024 * 1024,
      rssKb: (200 + sampleIndex) * 1024,
      vszBytes: 500 * 1024 * 1024,
      vszKb: 500 * 1024,
      elapsed: `00:0${sampleIndex}`,
      command: '/App/Happierinternaldev',
    }),
    runMemoryMap: async (pid, options) => {
      memoryMapCalls.push({ pid, phase: options.phase, outputFile: options.outputFile });
      return { ok: true, file: options.outputFile, phase: options.phase };
    },
  });

  assert.deepEqual(
    memoryMapCalls.map((call) => call.phase),
    ['start', 'end'],
  );
  assert.equal(result.memoryMaps.start.ok, true);
  assert.equal(result.memoryMaps.start.phase, 'start');
  assert.equal(result.memoryMaps.end.ok, true);
  assert.equal(result.memoryMaps.end.phase, 'end');
  assert.match(result.artifacts.vmmapStart, /ios-memory-map-vmmap-start\.txt$/);
  assert.match(result.artifacts.vmmapEnd, /ios-memory-map-vmmap-end\.txt$/);
});

test('runProcessProfile does not let start memory-map capture delay CPU and RSS sampling', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'happier-process-profile-memory-map-nonblocking-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  });

  const order = [];
  const waitOneTurn = () => new Promise((resolve) => setImmediate(resolve));
  const result = await runProcessProfile({
    pid: 67164,
    label: 'ios-memory-map-nonblocking',
    outputDir,
    durationMs: 1_000,
    intervalMs: 1_000,
    memoryMap: true,
    now: () => 1_000_000,
    sleep: async () => {},
    sampleProcess: async (_pid, { sampleIndex }) => {
      order.push(`sample-${sampleIndex}`);
      return {
        pid: 67164,
        cpuPercent: sampleIndex,
        rssBytes: (200 + sampleIndex) * 1024 * 1024,
        rssKb: (200 + sampleIndex) * 1024,
        vszBytes: 500 * 1024 * 1024,
        vszKb: 500 * 1024,
        elapsed: `00:0${sampleIndex}`,
        command: '/App/Happierinternaldev',
      };
    },
    runMemoryMap: async (pid, options) => {
      order.push(`${options.phase}-vmmap-start`);
      assert.equal(pid, 67164);
      if (options.phase === 'start') {
        await waitOneTurn();
      }
      order.push(`${options.phase}-vmmap-end`);
      return { ok: true, file: options.outputFile, phase: options.phase };
    },
  });

  assert.equal(result.summary.sampleCount, 2);
  assert.ok(
    order.indexOf('sample-0') < order.indexOf('start-vmmap-end'),
    `expected sampling to begin before start vmmap completed; observed order: ${order.join(', ')}`,
  );
  assert.equal(result.memoryMaps.start.ok, true);
  assert.equal(result.memoryMaps.end.ok, true);
});
