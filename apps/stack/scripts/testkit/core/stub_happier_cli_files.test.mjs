import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';

import { createTempFixture } from './temp_fixture.mjs';
import { writeStubHappierCliFiles } from './stub_happier_cli_files.mjs';

const execFileAsync = promisify(execFile);

test('writeStubHappierCliFiles writes package.json when requested', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-stub-happier-cli-files-' });

  await writeStubHappierCliFiles(fixture.root, {
    packageJsonContent: '{\"name\":\"stub-cli\"}\n',
    distIndexScript: 'process.exit(0);\n',
    binHappierScript: 'process.exit(0);\n',
  });

  const packageJson = await readFile(join(fixture.root, 'apps', 'cli', 'package.json'), 'utf-8');
  assert.equal(packageJson, '{"name":"stub-cli"}\n');
});

test('writeStubHappierCliFiles makes daemon help probes side-effect free', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-stub-happier-cli-probe-' });
  const markerPath = join(fixture.root, 'unexpected-side-effect');

  await writeStubHappierCliFiles(fixture.root, {
    distIndexScript: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'ran');\nprocess.exit(42);\n`,
  });

  await assert.doesNotReject(execFileAsync(
    process.execPath,
    [join(fixture.root, 'apps', 'cli', 'dist', 'index.mjs'), 'daemon', '--help'],
    { env: { ...process.env, HAPPIER_CLI_DIST_INTEGRITY_PROBE: 'daemon-command' } },
  ));
  await assert.rejects(readFile(markerPath, 'utf-8'), { code: 'ENOENT' });
});
