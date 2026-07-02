import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_PROFILE_DURATION_MS = 30_000;
export const DEFAULT_PROFILE_INTERVAL_MS = 1_000;
export const DEFAULT_CPU_SAMPLE_INTERVAL_MS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse ${field} from "${value}".`);
  }
  return parsed;
}

export function parseDurationMs(raw, field = 'duration') {
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!match) {
    throw new Error(`Invalid ${field}: "${raw}". Use milliseconds, or suffix with ms/s/m.`);
  }
  const numeric = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const ms = Math.round(numeric * multiplier);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`Invalid ${field}: "${raw}". Value must be greater than zero.`);
  }
  return ms;
}

export function parsePositiveInteger(raw, field) {
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${field}: "${raw}". Value must be a positive integer.`);
  }
  return value;
}

export function parseProcessMetrics(stdout) {
  const line = String(stdout)
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) {
    throw new Error('Process metrics command returned no rows.');
  }
  const parts = line.split(/\s+/);
  if (parts.length < 6) {
    throw new Error(`Process metrics row had too few fields: "${line}".`);
  }
  const [pidRaw, cpuRaw, rssRaw, vszRaw, elapsed, ...commandParts] = parts;
  const rssKb = toNumber(rssRaw, 'RSS');
  const vszKb = toNumber(vszRaw, 'VSZ');
  return {
    pid: parsePositiveInteger(pidRaw, 'pid'),
    cpuPercent: toNumber(cpuRaw, 'CPU percent'),
    rssBytes: rssKb * 1024,
    rssKb,
    vszBytes: vszKb * 1024,
    vszKb,
    elapsed,
    command: commandParts.join(' '),
  };
}

export function parseProcessList(stdout) {
  return String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter((entry) => entry && Number.isSafeInteger(entry.pid) && entry.pid > 0);
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(command, args) {
  return [shellQuote(command), ...args.map(shellQuote)].join(' ');
}

function runTextCommandDirect(command, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal}. ${stderr.trim()}`.trim()));
    });
  });
}

function isSpawnPermissionError(error) {
  return error?.code === 'EPERM' || error?.code === 'EACCES';
}

export async function runTextCommand(
  command,
  args,
  { timeoutMs = 10_000, allowShellFallback = true, preferShell = false } = {},
) {
  if (preferShell) {
    return runTextCommandDirect('/bin/bash', ['-lc', buildShellCommand(command, args)], { timeoutMs });
  }
  try {
    return await runTextCommandDirect(command, args, { timeoutMs });
  } catch (error) {
    if (!allowShellFallback || !isSpawnPermissionError(error)) {
      throw error;
    }
    return runTextCommandDirect('/bin/bash', ['-lc', buildShellCommand(command, args)], {
      timeoutMs,
    });
  }
}

export async function defaultListProcesses() {
  const stdout = await runTextCommand('ps', ['-axo', 'pid=', '-o', 'command='], { timeoutMs: 2_000 });
  return parseProcessList(stdout);
}

export async function defaultSampleProcess(pid) {
  const stdout = await runTextCommand(
    'ps',
    [
      '-p',
      String(pid),
      '-o',
      'pid=',
      '-o',
      'pcpu=',
      '-o',
      'rss=',
      '-o',
      'vsz=',
      '-o',
      'etime=',
      '-o',
      'command=',
    ],
    { timeoutMs: 2_000 },
  );
  return parseProcessMetrics(stdout);
}

export async function resolveProcessTarget({ pid, commandMatch, listProcesses = defaultListProcesses } = {}) {
  if (pid != null) {
    return { pid: parsePositiveInteger(pid, 'pid'), command: null, source: 'pid' };
  }
  if (!commandMatch) {
    throw new Error('Pass --pid or --command-match to select one process.');
  }
  const needle = String(commandMatch).toLowerCase();
  const matches = (await listProcesses()).filter((entry) => entry.command.toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new Error(`--command-match "${commandMatch}" matched no processes.`);
  }
  if (matches.length > 1) {
    const preview = matches.slice(0, 5).map((entry) => `${entry.pid}: ${entry.command}`).join('\n');
    throw new Error(`--command-match "${commandMatch}" matched ${matches.length} processes; use --pid instead.\n${preview}`);
  }
  return { ...matches[0], source: 'command-match' };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarizeProcessSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      sampleCount: 0,
      durationMs: 0,
      cpu: { averagePercent: 0, maxPercent: 0 },
      memory: {
        rssStartBytes: 0,
        rssEndBytes: 0,
        rssMinBytes: 0,
        rssMaxBytes: 0,
        rssDeltaBytes: 0,
        rssGrowthPerMinuteBytes: 0,
      },
    };
  }
  const cpuValues = samples.map((sample) => sample.cpuPercent);
  const rssValues = samples.map((sample) => sample.rssBytes);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const durationMs = Math.max(0, last.elapsedMs - first.elapsedMs);
  const rssDeltaBytes = last.rssBytes - first.rssBytes;
  return {
    sampleCount: samples.length,
    durationMs,
    cpu: {
      averagePercent: round(cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length),
      maxPercent: round(Math.max(...cpuValues)),
    },
    memory: {
      rssStartBytes: first.rssBytes,
      rssEndBytes: last.rssBytes,
      rssMinBytes: Math.min(...rssValues),
      rssMaxBytes: Math.max(...rssValues),
      rssDeltaBytes,
      rssGrowthPerMinuteBytes: durationMs > 0 ? Math.round((rssDeltaBytes / durationMs) * 60_000) : 0,
    },
  };
}

function safeLabel(value) {
  const label = String(value ?? 'process-profile')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return label || 'process-profile';
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z');
}

function createArtifactPaths({ outputDir, label, startedAt }) {
  const base = `${timestampForPath(startedAt)}-${safeLabel(label)}`;
  return {
    samples: join(outputDir, `${base}-samples.ndjson`),
    summary: join(outputDir, `${base}-summary.json`),
    cpuProfile: join(outputDir, `${base}-cpu-sample.txt`),
    vmmapStart: join(outputDir, `${base}-vmmap-start.txt`),
    vmmapEnd: join(outputDir, `${base}-vmmap-end.txt`),
  };
}

function runFileCommandDirect(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, command, args });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        signal: signal ?? null,
        stderr: stderr.trim(),
        command,
        args,
      });
    });
  });
}

async function runFileCommand(command, args, { timeoutMs = 60_000, allowShellFallback = true } = {}) {
  const result = await runFileCommandDirect(command, args, { timeoutMs });
  if (result.ok || !allowShellFallback || result.error == null) {
    return result;
  }
  if (!/spawn\s+(EPERM|EACCES)/.test(result.error) && !/(EPERM|EACCES)/.test(result.error)) {
    return result;
  }
  return runFileCommandDirect('/bin/bash', ['-lc', buildShellCommand(command, args)], { timeoutMs });
}

export async function defaultRunCpuStackSample(pid, { durationMs, sampleIntervalMs, outputFile }) {
  const durationSeconds = Math.max(1, Math.ceil(durationMs / 1_000));
  const intervalMs = Math.max(1, Math.round(sampleIntervalMs));
  const result = await runFileCommand('sample', [String(pid), String(durationSeconds), String(intervalMs), '-file', outputFile], {
    timeoutMs: durationMs + 30_000,
  });
  return { ...result, file: outputFile };
}

export async function defaultRunMemoryMap(pid, { outputFile }) {
  const result = await runFileCommand('vmmap', ['-summary', String(pid), '-output', outputFile], { timeoutMs: 60_000 });
  return { ...result, file: outputFile };
}

export async function runProcessProfile({
  pid = null,
  commandMatch = null,
  label = null,
  outputDir = join(tmpdir(), 'happier-process-profiles'),
  durationMs = DEFAULT_PROFILE_DURATION_MS,
  intervalMs = DEFAULT_PROFILE_INTERVAL_MS,
  cpuProfileMs = 0,
  sampleIntervalMs = DEFAULT_CPU_SAMPLE_INTERVAL_MS,
  memoryMap = false,
  listProcesses = defaultListProcesses,
  sampleProcess = defaultSampleProcess,
  runCpuStackSample = defaultRunCpuStackSample,
  runMemoryMap = defaultRunMemoryMap,
  onFirstSample = null,
  now = () => Date.now(),
  sleep: sleepFn = sleep,
} = {}) {
  const target = await resolveProcessTarget({ pid, commandMatch, listProcesses });
  const normalizedDurationMs = parseDurationMs(durationMs, 'durationMs') ?? DEFAULT_PROFILE_DURATION_MS;
  const normalizedIntervalMs = parseDurationMs(intervalMs, 'intervalMs') ?? DEFAULT_PROFILE_INTERVAL_MS;
  const normalizedCpuProfileMs = cpuProfileMs ? parseDurationMs(cpuProfileMs, 'cpuProfileMs') : 0;
  const normalizedSampleIntervalMs = parsePositiveInteger(sampleIntervalMs, 'sampleIntervalMs');
  if (normalizedIntervalMs > normalizedDurationMs) {
    throw new Error('intervalMs must be less than or equal to durationMs.');
  }

  await mkdir(outputDir, { recursive: true });
  const startedAt = new Date(now());
  const profileLabel = label ?? `pid-${target.pid}`;
  const artifacts = createArtifactPaths({ outputDir, label: profileLabel, startedAt });
  const samples = [];

  const memoryMaps = memoryMap ? { start: null, end: null } : null;
  const captureMemoryMap = (phase, outputFile) =>
    runMemoryMap(target.pid, { outputFile, phase }).catch((error) => ({
      ok: false,
      error: error?.message ?? String(error),
      file: outputFile,
      phase,
    }));
  const startMemoryMapPromise = memoryMaps ? captureMemoryMap('start', artifacts.vmmapStart) : null;

  const sampleCount = Math.floor(normalizedDurationMs / normalizedIntervalMs) + 1;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const metrics = await sampleProcess(target.pid, { sampleIndex });
    const sample = {
      ...metrics,
      timestamp: new Date(now()).toISOString(),
      elapsedMs: Math.min(sampleIndex * normalizedIntervalMs, normalizedDurationMs),
    };
    samples.push(sample);
    if (sampleIndex === 0 && typeof onFirstSample === 'function') {
      await onFirstSample(sample);
    }
    if (sampleIndex < sampleCount - 1) {
      await sleepFn(normalizedIntervalMs);
    }
  }

  if (memoryMaps) {
    memoryMaps.start = await startMemoryMapPromise;
    memoryMaps.end = await captureMemoryMap('end', artifacts.vmmapEnd);
  }

  const summary = summarizeProcessSamples(samples);
  const cpuProfile = normalizedCpuProfileMs
    ? await runCpuStackSample(target.pid, {
        durationMs: normalizedCpuProfileMs,
        sampleIntervalMs: normalizedSampleIntervalMs,
        outputFile: artifacts.cpuProfile,
      }).catch((error) => ({ ok: false, error: error?.message ?? String(error), file: artifacts.cpuProfile }))
    : null;
  await writeFile(artifacts.samples, samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n', 'utf-8');

  const result = {
    version: 1,
    label: profileLabel,
    target,
    parameters: {
      durationMs: normalizedDurationMs,
      intervalMs: normalizedIntervalMs,
      cpuProfileMs: normalizedCpuProfileMs,
      sampleIntervalMs: normalizedSampleIntervalMs,
      memoryMap,
    },
    startedAt: startedAt.toISOString(),
    endedAt: new Date(now()).toISOString(),
    artifacts: {
      samples: artifacts.samples,
      summary: artifacts.summary,
      cpuProfile: cpuProfile?.file ?? null,
      vmmapStart: memoryMaps?.start?.file ?? null,
      vmmapEnd: memoryMaps?.end?.file ?? null,
    },
    summary,
    cpuProfile,
    memoryMaps,
  };

  await writeFile(artifacts.summary, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  return result;
}
