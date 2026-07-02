import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildArgentFlowYaml,
  executeMobileProfileScenarioSteps,
  findReactTestIdTapCoordinates,
  listMobileProfileScenarios,
  resolveMobileProfileScenario,
  runMobileProfileScenario,
  writeArgentFlowFile,
} from './mobile_profile_scenarios.mjs';

test('mobile profile scenario catalog covers the priority iOS profiling flows', () => {
  const names = listMobileProfileScenarios().map((scenario) => scenario.name);

  assert.deepEqual(
    [
      'ios-session-list',
      'ios-root-tabs',
      'ios-idle-session',
      'ios-streaming-session',
      'ios-cockpit-tabs',
      'ios-back-swipe',
      'ios-long-idle-tail',
      'ios-long-session-root-cockpit-cycle',
    ].filter((name) => !names.includes(name)),
    [],
  );
});

test('buildArgentFlowYaml materializes the current simulator and Metro prerequisites', () => {
  const yaml = buildArgentFlowYaml({
    scenarioName: 'ios-session-list',
    udid: 'SIM-123',
    metroPort: 18829,
  });

  assert.match(yaml, /executionPrerequisite: .*SIM-123/);
  assert.match(yaml, /executionPrerequisite: .*18829/);
  assert.match(yaml, /tool: gesture-swipe/);
  assert.match(yaml, /udid: "SIM-123"/);
  assert.doesNotMatch(yaml, /9B3E3E79-3BF3-4059-B5E4-A94AFF34BD81/);
  assert.doesNotMatch(yaml, /Metro 8081/);
});

test('priority session-view scenarios target real session rows instead of the backup card', () => {
  const idleYaml = buildArgentFlowYaml({
    scenarioName: 'ios-idle-session',
    udid: 'SIM-123',
    metroPort: 18829,
  });
  const streamingYaml = buildArgentFlowYaml({
    scenarioName: 'ios-streaming-session',
    udid: 'SIM-123',
    metroPort: 18829,
  });

  assert.match(idleYaml, /Open the target idle session row[\s\S]*x: 0\.5[\s\S]*y: 0\.542/);
  assert.match(streamingYaml, /Open the target streaming session row[\s\S]*x: 0\.5[\s\S]*y: 0\.681/);
  assert.doesNotMatch(idleYaml, /Open the target idle session row[\s\S]*y: 0\.306/);
  assert.doesNotMatch(idleYaml, /Open the target idle session row[\s\S]*y: 0\.424/);
  assert.doesNotMatch(streamingYaml, /Open the target streaming session row[\s\S]*y: 0\.78/);
});

test('idle session scenario waits for session navigation to settle before validating session view', () => {
  const idleYaml = buildArgentFlowYaml({
    scenarioName: 'ios-idle-session',
    udid: 'SIM-123',
    metroPort: 18829,
  });

  assert.match(idleYaml, /Confirm idle session view is visible[\s\S]*delayMs: 5000/);
});

test('streaming session scenario waits for live navigation to settle before validating session view', () => {
  const streamingYaml = buildArgentFlowYaml({
    scenarioName: 'ios-streaming-session',
    udid: 'SIM-123',
    metroPort: 18829,
  });

  assert.match(streamingYaml, /Confirm streaming session view is visible[\s\S]*delayMs: 5000/);
});

test('root tab scenarios use semantic tab test IDs instead of static tab coordinates', () => {
  const yaml = buildArgentFlowYaml({
    scenarioName: 'ios-root-tabs',
    udid: 'SIM-123',
    metroPort: 18829,
  });

  assert.match(yaml, /Open Settings root tab[\s\S]*tool: tap-react-test-id[\s\S]*testID: "tabbar-tab-settings"/);
  assert.match(yaml, /Return to sessions\/list root tab[\s\S]*tool: tap-react-test-id[\s\S]*testID: "tabbar-tab-sessions"/);
  assert.doesNotMatch(yaml, /x: 0\.64/);
  assert.doesNotMatch(yaml, /x: 0\.501/);
  assert.doesNotMatch(yaml, /x: 0\.15/);
});

test('findReactTestIdTapCoordinates resolves visible tap coordinates from debugger component tree text', () => {
  const coordinates = findReactTestIdTapCoordinates(
    [
      'MobileBottomChromeHost (tap: 0.50,0.96)',
      '  Pressable [testID=tabbar-tab-inbox] (tap: 0.36,0.95)',
      '  Pressable [testID=tabbar-tab-sessions] (tap: 0.50,0.95)',
      '  Pressable [testID=tabbar-tab-settings] (tap: 0.64,0.95)',
    ].join('\n'),
    'tabbar-tab-settings',
  );

  assert.deepEqual(coordinates, {
    x: 0.64,
    y: 0.95,
    line: 'Pressable [testID=tabbar-tab-settings] (tap: 0.64,0.95)',
  });
});

test('findReactTestIdTapCoordinates rejects offscreen coordinates', () => {
  assert.equal(
    findReactTestIdTapCoordinates('Pressable [testID=settings-pets-row] (tap: 0.50,1.03)', 'settings-pets-row'),
    null,
  );
});

test('writeArgentFlowFile writes a named flow under the requested flow directory', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'happier-mobile-profile-flow-'));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  const result = await writeArgentFlowFile({
    projectRoot,
    flowDir: '.argent/flows',
    scenarioName: 'ios-cockpit-tabs',
    udid: 'SIM-456',
    metroPort: 18829,
  });

  assert.match(result.file, /\.argent\/flows\/happier-ios-cockpit-tabs-profile\.yaml$/);
  const saved = await readFile(result.file, 'utf-8');
  assert.equal(saved, result.yaml);
  assert.match(saved, /Open cockpit tab 2/);
  assert.match(saved, /Return to cockpit tab 1\/chat/);
});

test('resolveMobileProfileScenario fails closed on unknown scenario names', () => {
  assert.throws(() => resolveMobileProfileScenario('ios-unknown-flow'), /Unknown mobile profiling scenario/);
});

test('runMobileProfileScenario fails flow checkpoint validation on silent route misfires', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'happier-mobile-profile-validation-'));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  const result = await runMobileProfileScenario({
    projectRoot,
    scenarioName: 'ios-session-list',
    udid: 'SIM-789',
    executeFlow: true,
    profileProcess: false,
    now: () => 1_000_000,
    executeArgentFlowFn: async () => ({
      ok: true,
      json: {
        steps: [
          { kind: 'echo', message: 'Confirm session list is visible before list profiling' },
          {
            kind: 'tool',
            tool: 'describe',
            result: { description: 'AXGroup "Keyboard shortcuts"' },
          },
          { kind: 'echo', message: 'Confirm session list remains visible after scrolling' },
          {
            kind: 'tool',
            tool: 'describe',
            result: { description: 'AXGroup "Keyboard shortcuts"' },
          },
        ],
      },
    }),
  });

  assert.equal(result.flowResult.ok, true);
  assert.equal(result.flowValidation.ok, false);
  assert.equal(result.flowValidation.checks.some((check) => check.ok === false && check.expected === 'sessions-list'), true);
  const manifest = JSON.parse(await readFile(result.artifacts.manifest, 'utf-8'));
  assert.equal(manifest.flowValidation.ok, false);
});

test('executeMobileProfileScenarioSteps resolves React testID taps through debugger component tree', async () => {
  const events = [];
  const result = await executeMobileProfileScenarioSteps({
    projectRoot: '/tmp/happier',
    scenario: {
      steps: [
        { label: 'Open Settings root tab', tool: 'tap-react-test-id', delayMs: 5, args: { testID: 'tabbar-tab-settings' } },
        { label: 'Confirm Settings surface is visible', tool: 'describe', args: {}, expectDescription: 'settings-surface' },
      ],
    },
    udid: 'SIM-123',
    metroPort: 18829,
    sleep: async (ms) => {
      events.push(['sleep', ms]);
    },
    runCommand: async (_command, args) => {
      events.push(args);
      if (args.includes('debugger-component-tree')) {
        return {
          ok: true,
          json: 'Pressable [testID=tabbar-tab-settings] (tap: 0.64,0.95)',
        };
      }
      if (args.includes('gesture-tap')) {
        return { ok: true, json: { tapped: true } };
      }
      if (args.includes('describe')) {
        return { ok: true, json: { description: 'AXGroup "Settings"' } };
      }
      return { ok: false, stderr: 'unexpected command' };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events[0], ['sleep', 5]);
  assert.deepEqual(events[1].slice(0, 4), ['run', 'debugger-component-tree', '--device_id', 'SIM-123']);
  assert.deepEqual(events[2], ['run', 'gesture-tap', '--udid', 'SIM-123', '--x', '0.64', '--y', '0.95', '--json']);
  assert.deepEqual(events[3], ['run', 'describe', '--udid', 'SIM-123', '--json']);
  assert.equal(result.json.steps.some((step) => step.kind === 'tool' && step.tool === 'gesture-tap'), true);
});

test('executeMobileProfileScenarioSteps fails closed when a semantic testID is not visible', async () => {
  const result = await executeMobileProfileScenarioSteps({
    projectRoot: '/tmp/happier',
    scenario: {
      steps: [{ label: 'Open Settings root tab', tool: 'tap-react-test-id', args: { testID: 'tabbar-tab-settings' } }],
    },
    udid: 'SIM-123',
    metroPort: 18829,
    runCommand: async () => ({ ok: true, json: 'Pressable [testID=tabbar-tab-settings] (tap: 0.64,1.12)' }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Could not find a visible tap coordinate/);
});

test('executeMobileProfileScenarioSteps reuses same-run semantic tap coordinates after first resolution', async () => {
  const commands = [];
  const result = await executeMobileProfileScenarioSteps({
    projectRoot: '/tmp/happier',
    scenario: {
      steps: [
        { label: 'Open Settings root tab', tool: 'tap-react-test-id', args: { testID: 'tabbar-tab-settings' } },
        { label: 'Reselect Settings root tab', tool: 'tap-react-test-id', args: { testID: 'tabbar-tab-settings' } },
      ],
    },
    udid: 'SIM-123',
    metroPort: 18829,
    runCommand: async (_command, args) => {
      commands.push(args);
      if (args.includes('debugger-component-tree')) {
        return { ok: true, json: 'Pressable [testID=tabbar-tab-settings] (tap: 0.64,0.95)' };
      }
      return { ok: true, json: { tapped: true } };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(commands.filter((args) => args.includes('debugger-component-tree')).length, 1);
  assert.equal(commands.filter((args) => args.includes('gesture-tap')).length, 2);
});

test('runMobileProfileScenario waits for the first process sample before executing the mobile flow', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'happier-mobile-profile-ready-'));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  const events = [];
  let releaseFirstSample;
  const firstSampleGate = new Promise((resolve) => {
    releaseFirstSample = resolve;
  });
  const runPromise = runMobileProfileScenario({
    projectRoot,
    scenarioName: 'ios-session-list',
    udid: 'SIM-789',
    executeFlow: true,
    profileProcess: true,
    pid: 1234,
    durationMs: 2_000,
    intervalMs: 1_000,
    profileStartDelayMs: 1,
    now: () => 1_000_000,
    sleep: async (ms) => {
      events.push(['sleep', ms]);
    },
    runProcessProfileFn: async (input) => {
      events.push(['profile-start', input.pid, input.label]);
      await firstSampleGate;
      events.push(['first-sample']);
      input.onFirstSample?.({ pid: input.pid, cpuPercent: 1, rssBytes: 100 });
      return {
        target: { pid: input.pid },
        summary: { sampleCount: 3 },
        artifacts: { summary: '/tmp/profile-summary.json' },
      };
    },
    executeArgentFlowFn: async (input) => {
      events.push(['flow-execute', input.flowName]);
      return { ok: true, json: { steps: [] } };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event[0] === 'flow-execute'), false);
  releaseFirstSample();
  await runPromise;

  assert.deepEqual(events, [
    ['profile-start', 1234, 'ios-session-list'],
    ['first-sample'],
    ['sleep', 1],
    ['flow-execute', 'happier-ios-session-list-profile'],
  ]);
});

test('runMobileProfileScenario can write and execute a flow while reusing process profiling', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'happier-mobile-profile-run-'));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  const events = [];
  const result = await runMobileProfileScenario({
    projectRoot,
    scenarioName: 'ios-session-list',
    udid: 'SIM-789',
    executeFlow: true,
    profileProcess: true,
    pid: 1234,
    durationMs: 2_000,
    intervalMs: 1_000,
    profileStartDelayMs: 1,
    now: () => 1_000_000,
    sleep: async (ms) => {
      events.push(['sleep', ms]);
    },
    runProcessProfileFn: async (input) => {
      events.push(['profile-start', input.pid, input.label]);
      input.onFirstSample?.({ pid: input.pid, cpuPercent: 1, rssBytes: 100 });
      return {
        target: { pid: input.pid },
        summary: { sampleCount: 3 },
        artifacts: { summary: '/tmp/profile-summary.json' },
      };
    },
    executeArgentFlowFn: async (input) => {
      events.push(['flow-execute', input.flowName, input.flowFile.endsWith('happier-ios-session-list-profile.yaml')]);
      return { ok: true, json: { ran: true } };
    },
  });

  assert.equal(result.scenario.name, 'ios-session-list');
  assert.equal(result.profile.target.pid, 1234);
  assert.equal(result.flowResult.ok, true);
  assert.match(result.artifacts.manifest, /ios-session-list-mobile-profile-manifest\.json$/);
  const manifest = JSON.parse(await readFile(result.artifacts.manifest, 'utf-8'));
  assert.equal(manifest.scenario.name, 'ios-session-list');
  assert.equal(manifest.profile.target.pid, 1234);
  assert.deepEqual(events, [
    ['profile-start', 1234, 'ios-session-list'],
    ['sleep', 1],
    ['flow-execute', 'happier-ios-session-list-profile', true],
  ]);
});
