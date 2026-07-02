import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IOS_MEMORY_PROFILING_AUTOLINKING_EXCLUDES,
  patchIosPodfileAutolinkingForMemoryProfiling,
} from './ios_podfile_autolinking.mjs';

const GENERATED_PODFILE = `target 'Happierdev' do
  use_expo_modules!

  if ENV['EXPO_USE_COMMUNITY_AUTOLINKING'] == '1'
    config_command = ['node', '-e', "process.argv=['', '', 'config'];require('@react-native-community/cli').run()"];
  else
    config_command = [
      'node',
      '--no-warnings',
      '--eval',
      'require(\\'expo/bin/autolinking\\')',
      'expo-modules-autolinking',
      'react-native-config',
      '--json',
      '--platform',
      'ios'
    ]
  end

  config = use_native_modules!(config_command)
end
`;

test('patchIosPodfileAutolinkingForMemoryProfiling excludes dev-client modules from Expo and React Native autolinking', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-pod-autolinking-'));
  try {
    const uiDir = join(tmp, 'apps', 'ui');
    await mkdir(join(uiDir, 'ios'), { recursive: true });
    const podfilePath = join(uiDir, 'ios', 'Podfile');
    await writeFile(podfilePath, GENERATED_PODFILE, 'utf8');

    const result = await patchIosPodfileAutolinkingForMemoryProfiling({ uiDir });

    const podfile = await readFile(podfilePath, 'utf8');
    const rubyExcludeArray = IOS_MEMORY_PROFILING_AUTOLINKING_EXCLUDES.map((name) => `'${name}'`).join(', ');
    assert.equal(result.changed, true);
    assert.match(podfile, new RegExp(`use_expo_modules!\\(\\{ :exclude => \\[${rubyExcludeArray}\\] \\}\\)`));
    assert.match(
      podfile,
      /'react-native-config',[\s\S]*'--platform',\s*'ios',\s*'--exclude',\s*'expo-dev-client',\s*'expo-dev-launcher',\s*'expo-dev-menu',\s*'expo-dev-menu-interface'/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('patchIosPodfileAutolinkingForMemoryProfiling is idempotent', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-pod-autolinking-'));
  try {
    const uiDir = join(tmp, 'apps', 'ui');
    await mkdir(join(uiDir, 'ios'), { recursive: true });
    const podfilePath = join(uiDir, 'ios', 'Podfile');
    await writeFile(podfilePath, GENERATED_PODFILE, 'utf8');

    await patchIosPodfileAutolinkingForMemoryProfiling({ uiDir });
    const once = await readFile(podfilePath, 'utf8');
    const result = await patchIosPodfileAutolinkingForMemoryProfiling({ uiDir });
    const twice = await readFile(podfilePath, 'utf8');

    assert.equal(result.changed, false);
    assert.equal(twice, once);
    for (const moduleName of IOS_MEMORY_PROFILING_AUTOLINKING_EXCLUDES) {
      assert.equal((twice.match(new RegExp(`'${moduleName}'`, 'g')) ?? []).length, 2);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
