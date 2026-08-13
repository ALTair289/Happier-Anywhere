import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from 'yaml';

test('nightly dev schedule avoids top-of-hour GitHub Actions load', () => {
  const workflow = parse(readFileSync('.github/workflows/nightly-dev.yml', 'utf8')) as {
    on?: {
      schedule?: Array<{ cron?: string }>;
    };
  };

  const schedules = workflow.on?.schedule ?? [];
  assert.ok(schedules.length > 0, 'nightly-dev.yml should define a schedule');

  for (const schedule of schedules) {
    const cron = String(schedule.cron ?? '').trim();
    const [minute] = cron.split(/\s+/);
    assert.notEqual(minute, '0', `scheduled workflow cron should avoid minute 0: ${cron}`);
  }
});

test('extended DB matrix runs the bounded fast E2E lane for each external database', () => {
  const workflow = parse(readFileSync('.github/workflows/extended-db-tests.yml', 'utf8')) as {
    jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
  };

  const runCommands = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => String(step.run ?? '').trim())
    .filter(Boolean);

  assert.equal(
    runCommands.filter((command) => command === 'yarn test:e2e:core:fast').length,
    2,
    'Postgres and MySQL must each run the bounded fast E2E lane',
  );
  assert.equal(
    runCommands.filter((command) => command === 'yarn test:e2e').length,
    0,
    'the full fast+slow+testkit suite cannot fit safely in one external-DB job',
  );
});
