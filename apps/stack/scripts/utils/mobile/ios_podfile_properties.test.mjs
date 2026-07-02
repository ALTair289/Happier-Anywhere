import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchIosPodfilePropertiesForMobileBuild } from './ios_podfile_properties.mjs';

test('patchIosPodfilePropertiesForMobileBuild preserves normal profiling runtime dev-client inspector setting', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-pod-props-'));
  try {
    const uiDir = join(tmp, 'apps', 'ui');
    await mkdir(join(uiDir, 'ios'), { recursive: true });
    const podPropsPath = join(uiDir, 'ios', 'Podfile.properties.json');
    await writeFile(
      podPropsPath,
      JSON.stringify({ EX_DEV_CLIENT_NETWORK_INSPECTOR: 'true', ios: { deploymentTarget: '15.1' } }, null, 2),
      'utf8',
    );

    await patchIosPodfilePropertiesForMobileBuild({ uiDir, memoryAttribution: false });

    const next = JSON.parse(await readFile(podPropsPath, 'utf8'));
    assert.equal(next['ios.deploymentTarget'], '16.0');
    assert.equal(next['ios.buildReactNativeFromSource'], 'true');
    assert.equal(next.EX_DEV_CLIENT_NETWORK_INSPECTOR, 'true');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('patchIosPodfilePropertiesForMobileBuild disables dev-client network inspector for memory attribution builds', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-pod-props-'));
  try {
    const uiDir = join(tmp, 'apps', 'ui');
    await mkdir(join(uiDir, 'ios'), { recursive: true });
    const podPropsPath = join(uiDir, 'ios', 'Podfile.properties.json');
    await writeFile(
      podPropsPath,
      JSON.stringify({ EX_DEV_CLIENT_NETWORK_INSPECTOR: 'true', ios: { deploymentTarget: '15.1' } }, null, 2),
      'utf8',
    );

    await patchIosPodfilePropertiesForMobileBuild({ uiDir, memoryAttribution: true });

    const next = JSON.parse(await readFile(podPropsPath, 'utf8'));
    assert.equal(next['ios.deploymentTarget'], '16.0');
    assert.equal(next['ios.buildReactNativeFromSource'], 'true');
    assert.equal(next.EX_DEV_CLIENT_NETWORK_INSPECTOR, 'false');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
