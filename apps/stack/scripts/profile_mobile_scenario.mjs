#!/usr/bin/env node
import './utils/env/env.mjs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRepoDir, getRootDir } from './utils/paths/paths.mjs';
import {
  DEFAULT_MOBILE_PROFILE_APP_PROCESS,
  DEFAULT_MOBILE_PROFILE_FLOW_DIR,
  DEFAULT_MOBILE_PROFILE_METRO_PORT,
  DEFAULT_MOBILE_PROFILE_START_DELAY_MS,
  listMobileProfileScenarios,
  resolveMobileProfileScenario,
  resolveMobileProfileTargetPlan,
  runMobileProfileScenario,
} from './profiling/mobile_profile_scenarios.mjs';
import {
  DEFAULT_CPU_SAMPLE_INTERVAL_MS,
  DEFAULT_PROFILE_DURATION_MS,
  DEFAULT_PROFILE_INTERVAL_MS,
  parseDurationMs,
  parsePositiveInteger,
} from './profiling/process_profiler.mjs';

function usage() {
  return [
    '[profile-mobile-scenario] usage:',
    '  hstack tools profile-mobile-scenario --list [--json]',
    '  hstack tools profile-mobile-scenario --scenario=<name> --udid=<ios-udid> [--metro-port=18829] [--project-root=<repo>] [--flow-dir=.argent/flows] [--json]',
    '  hstack tools profile-mobile-scenario --scenario=<name> --udid=<ios-udid> --execute-flow [--json]',
    '  hstack tools profile-mobile-scenario --scenario=<name> --udid=<ios-udid> --execute-flow --profile-process [--pid=<pid>|--command-match=Happierinternaldev] [--duration=30s] [--interval=1s] [--stack-sample=10s] [--out-dir=<dir>] [--json]',
    '  hstack tools profile-mobile-scenario --scenario=<name> --udid=<ios-udid> --profile-process --dry-run [--json]',
    '',
    'Notes:',
    '  - Generates current-device Argent flow YAML before execution.',
    '  - Process profiling reuses hstack tools profile-processes logic and reports RSS/CPU facts only.',
    '  - RSS growth is memory pressure evidence, not an attributed leak.',
    '  - Native xctrace Allocations/Leaks attribution still requires a dedicated memory-profiling build.',
  ].join('\n');
}

function readValue(kv, ...names) {
  for (const name of names) {
    if (kv.has(name)) return kv.get(name);
  }
  return null;
}

function textScenarioList(scenarios) {
  return scenarios.map((scenario) => `- ${scenario.name}: ${scenario.description}`).join('\n');
}

function textSummary(result) {
  const lines = [
    `[profile-mobile-scenario] scenario: ${result.scenario.name}`,
    `[profile-mobile-scenario] flow: ${result.flow.file}`,
    `[profile-mobile-scenario] manifest: ${result.artifacts.manifest}`,
  ];
  if (result.executed) {
    lines.push(
      result.flowResult?.ok
        ? '[profile-mobile-scenario] flow execution: ok'
        : `[profile-mobile-scenario] flow execution: failed (${result.flowResult?.exitCode ?? result.flowResult?.signal ?? result.flowResult?.error ?? 'unknown'})`,
    );
    if (result.flowValidation) {
      const failedChecks = result.flowValidation.checks?.filter((check) => !check.ok).length ?? 0;
      lines.push(
        result.flowValidation.ok
          ? `[profile-mobile-scenario] flow checkpoints: ok (${result.flowValidation.checks.length})`
          : `[profile-mobile-scenario] flow checkpoints: failed (${failedChecks}/${result.flowValidation.checks.length})`,
      );
    }
  } else {
    lines.push('[profile-mobile-scenario] flow execution: skipped');
  }
  if (result.profile) {
    const cpu = result.profile.summary.cpu;
    const memory = result.profile.summary.memory;
    lines.push(
      `[profile-mobile-scenario] CPU avg ${cpu.averagePercent}% max ${cpu.maxPercent}%`,
      `[profile-mobile-scenario] RSS start ${memory.rssStartBytes} B, end ${memory.rssEndBytes} B, delta ${memory.rssDeltaBytes} B`,
      `[profile-mobile-scenario] process summary: ${result.profile.artifacts.summary}`,
    );
  }
  return lines.join('\n');
}

function dryRunText(plan) {
  const lines = [
    `[profile-mobile-scenario] scenario: ${plan.scenario.name}`,
    `[profile-mobile-scenario] flow file: ${plan.flow.file}`,
    `[profile-mobile-scenario] execute flow: ${plan.executeFlow ? 'yes' : 'no'}`,
    `[profile-mobile-scenario] profile process: ${plan.profileProcess ? 'yes' : 'no'}`,
  ];
  if (plan.target) {
    lines.push(`[profile-mobile-scenario] target pid: ${plan.target.pid}`);
  }
  lines.push(
    `[profile-mobile-scenario] duration: ${plan.parameters.durationMs}ms; interval: ${plan.parameters.intervalMs}ms`,
    plan.parameters.cpuProfileMs
      ? `[profile-mobile-scenario] cpu sample: ${plan.parameters.cpuProfileMs}ms @ ${plan.parameters.sampleIntervalMs}ms`
      : '[profile-mobile-scenario] cpu sample: disabled',
  );
  return lines.join('\n');
}

export async function runProfileMobileScenarioCli(argv = process.argv.slice(2), { env = process.env } = {}) {
  const rootDir = getRootDir(import.meta.url);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { usage: usage() }, text: usage() });
    return;
  }

  if (flags.has('--list')) {
    const scenarios = listMobileProfileScenarios().map((scenario) => ({
      name: scenario.name,
      flowName: scenario.flowName,
      description: scenario.description,
      prerequisite: scenario.prerequisite,
    }));
    printResult({ json, data: { scenarios }, text: textScenarioList(scenarios) });
    return;
  }

  const scenarioName = readValue(kv, '--scenario');
  const scenario = resolveMobileProfileScenario(scenarioName);
  const udid = readValue(kv, '--udid');
  if (!udid) {
    throw new Error('Pass --udid=<ios-udid> to generate or execute a mobile profiling scenario.');
  }

  const projectRoot = resolve(readValue(kv, '--project-root') ?? getRepoDir(rootDir, env));
  const flowDir = readValue(kv, '--flow-dir') ?? DEFAULT_MOBILE_PROFILE_FLOW_DIR;
  const metroPort =
    readValue(kv, '--metro-port', '--metroPort') == null
      ? DEFAULT_MOBILE_PROFILE_METRO_PORT
      : parsePositiveInteger(readValue(kv, '--metro-port', '--metroPort'), 'metro-port');
  const executeFlow = flags.has('--execute-flow') || flags.has('--execute');
  const profileProcess = flags.has('--profile-process') || flags.has('--profile');
  const dryRun = flags.has('--dry-run') || flags.has('--print-plan');

  const durationMs = parseDurationMs(readValue(kv, '--duration', '--duration-ms'), 'duration') ?? DEFAULT_PROFILE_DURATION_MS;
  const intervalMs = parseDurationMs(readValue(kv, '--interval', '--interval-ms'), 'interval') ?? DEFAULT_PROFILE_INTERVAL_MS;
  const cpuProfileMs =
    parseDurationMs(readValue(kv, '--stack-sample', '--stack-sample-ms', '--cpu-profile', '--cpu-profile-ms'), 'stack-sample') ?? 0;
  const sampleIntervalMs =
    readValue(kv, '--sample-interval', '--sample-interval-ms') == null
      ? DEFAULT_CPU_SAMPLE_INTERVAL_MS
      : parsePositiveInteger(readValue(kv, '--sample-interval', '--sample-interval-ms'), 'sample-interval');
  const profileStartDelayMs =
    parseDurationMs(readValue(kv, '--profile-start-delay', '--profile-start-delay-ms'), 'profile-start-delay') ??
    DEFAULT_MOBILE_PROFILE_START_DELAY_MS;
  const flowTimeoutMs = parseDurationMs(readValue(kv, '--flow-timeout', '--flow-timeout-ms'), 'flow-timeout') ?? 0;
  const outputDir = readValue(kv, '--out-dir') ?? join(env.TMPDIR || '/tmp', 'happier-mobile-profile-scenarios');
  const label = readValue(kv, '--label') ?? scenario.name;
  const pidRaw = readValue(kv, '--pid');
  const commandMatch = readValue(kv, '--command-match') ?? DEFAULT_MOBILE_PROFILE_APP_PROCESS;
  const pid = pidRaw == null ? null : parsePositiveInteger(pidRaw, 'pid');
  const memoryMap = flags.has('--memory-map');
  const argentBin = readValue(kv, '--argent-bin') ?? 'argent';

  if (dryRun) {
    const target = profileProcess ? await resolveMobileProfileTargetPlan({ pid, commandMatch }) : null;
    const flowFile = resolve(projectRoot, flowDir, `${scenario.flowName}.yaml`);
    const plan = {
      scenario: { name: scenario.name, flowName: scenario.flowName, description: scenario.description },
      projectRoot,
      flow: { file: flowFile, directory: resolve(projectRoot, flowDir) },
      executeFlow,
      profileProcess,
      target,
      parameters: {
        metroPort,
        durationMs,
        intervalMs,
        cpuProfileMs,
        sampleIntervalMs,
        profileStartDelayMs,
        flowTimeoutMs,
        memoryMap,
      },
    };
    printResult({ json, data: plan, text: dryRunText(plan) });
    return;
  }

  const result = await runMobileProfileScenario({
    projectRoot,
    scenarioName: scenario.name,
    udid,
    metroPort,
    flowDir,
    executeFlow,
    profileProcess,
    pid,
    commandMatch,
    label,
    outputDir,
    durationMs,
    intervalMs,
    cpuProfileMs,
    sampleIntervalMs,
    memoryMap,
    profileStartDelayMs,
    argentBin,
    env,
    flowTimeoutMs,
  });

  printResult({ json, data: result, text: textSummary(result) });
  if (result.executed && result.flowResult && !result.flowResult.ok) {
    process.exitCode = 1;
  }
  if (result.executed && result.flowValidation && !result.flowValidation.ok) {
    process.exitCode = 1;
  }
  if (result.profile?.cpuProfile && !result.profile.cpuProfile.ok) {
    process.exitCode = 1;
  }
  if (result.profile?.memoryMaps && [result.profile.memoryMaps.start, result.profile.memoryMaps.end].some((entry) => entry && !entry.ok)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProfileMobileScenarioCli().catch((err) => {
    console.error('[profile-mobile-scenario] failed:', err);
    process.exit(1);
  });
}
