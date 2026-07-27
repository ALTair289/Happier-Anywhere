import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchIosPodfilePropertiesForMobileBuild } from './ios_podfile_properties.mjs';

async function createUiDir(podfileProperties) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-pod-props-'));
  const uiDir = join(tmp, 'apps', 'ui');
  await mkdir(join(uiDir, 'ios'), { recursive: true });
  if (podfileProperties) {
    await writeFile(
      join(uiDir, 'ios', 'Podfile.properties.json'),
      JSON.stringify(podfileProperties, null, 2),
      'utf8',
    );
  }
  return { tmp, uiDir, podPropsPath: join(uiDir, 'ios', 'Podfile.properties.json') };
}

test('patchIosPodfilePropertiesForMobileBuild verifies the app-config-owned properties instead of rewriting them', async () => {
  // app.config.js is the single owner of these two properties; this step used to
  // write them too, which meant a plain `expo prebuild` silently produced a project
  // without them and nothing noticed (2026-07 dead-patch incident).
  const { tmp, uiDir, podPropsPath } = await createUiDir({
    EX_DEV_CLIENT_NETWORK_INSPECTOR: 'true',
    'ios.deploymentTarget': '16.4',
    'ios.buildReactNativeFromSource': 'true',
  });
  try {
    const result = await patchIosPodfilePropertiesForMobileBuild({ uiDir, memoryAttribution: false });

    assert.equal(result, true);
    const next = JSON.parse(await readFile(podPropsPath, 'utf8'));
    // Not forced back to this script's old hard-coded value.
    assert.equal(next['ios.deploymentTarget'], '16.4');
    assert.equal(next['ios.buildReactNativeFromSource'], 'true');
    assert.equal(next.EX_DEV_CLIENT_NETWORK_INSPECTOR, 'true');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('patchIosPodfilePropertiesForMobileBuild disables dev-client network inspector for memory attribution builds', async () => {
  const { tmp, uiDir, podPropsPath } = await createUiDir({
    EX_DEV_CLIENT_NETWORK_INSPECTOR: 'true',
    'ios.deploymentTarget': '16.0',
    'ios.buildReactNativeFromSource': 'true',
  });
  try {
    await patchIosPodfilePropertiesForMobileBuild({ uiDir, memoryAttribution: true });

    const next = JSON.parse(await readFile(podPropsPath, 'utf8'));
    assert.equal(next.EX_DEV_CLIENT_NETWORK_INSPECTOR, 'false');
    assert.equal(next['ios.buildReactNativeFromSource'], 'true');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('patchIosPodfilePropertiesForMobileBuild fails loudly when the generated project lacks the source build', async () => {
  // Silently repairing this is what hid the regression: the hstack path looked fine
  // while every other prebuild path produced a project with dead native patches.
  const { tmp, uiDir } = await createUiDir({ EX_DEV_CLIENT_NETWORK_INSPECTOR: 'true' });
  try {
    await assert.rejects(
      () => patchIosPodfilePropertiesForMobileBuild({ uiDir, memoryAttribution: false }),
      (error) => {
        assert.match(error.message, /buildReactNativeFromSource/);
        assert.match(error.message, /app\.config\.js/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('patchIosPodfilePropertiesForMobileBuild tolerates a missing properties file', async () => {
  const { tmp, uiDir } = await createUiDir(null);
  try {
    assert.equal(await patchIosPodfilePropertiesForMobileBuild({ uiDir, memoryAttribution: false }), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
