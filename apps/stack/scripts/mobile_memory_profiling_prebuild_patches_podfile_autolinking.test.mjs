import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack mobile --prebuild --profiling-runtime=memory patches iOS Podfile autolinking before pod install', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-memory-podfile-'));
  const repoDir = join(tmp, 'repo');
  const uiDir = join(repoDir, 'apps', 'ui');
  const storageDir = join(tmp, 'storage');
  const binDir = join(tmp, 'bin');
  const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');

  try {
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(storageDir, 'main'), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(uiDir, 'app.config.js'), 'export default {};\n', 'utf8');

    await writeFile(
      expoBin,
      `#!/usr/bin/env node
const fs = require('fs');
fs.mkdirSync('ios', { recursive: true });
// Mirrors a real prebuild: expo-build-properties writes these from app.config.js.
fs.writeFileSync('ios/Podfile.properties.json', JSON.stringify({
  EX_DEV_CLIENT_NETWORK_INSPECTOR: 'true',
  'ios.deploymentTarget': '16.0',
  'ios.buildReactNativeFromSource': 'true',
}, null, 2));
fs.writeFileSync('ios/Podfile', \`target 'Happierdev' do
  use_expo_modules!

  if ENV['EXPO_USE_COMMUNITY_AUTOLINKING'] == '1'
    config_command = ['node', '-e', "process.argv=['', '', 'config'];require('@react-native-community/cli').run()"];
  else
    config_command = [
      'node',
      '--no-warnings',
      '--eval',
      'require(\\\\'expo/bin/autolinking\\\\')',
      'expo-modules-autolinking',
      'react-native-config',
      '--json',
      '--platform',
      'ios'
    ]
  end

  config = use_native_modules!(config_command)
end
\`);
`,
      'utf8',
    );
    await writeFile(join(binDir, 'pod'), '#!/usr/bin/env sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
      await chmod(join(binDir, 'pod'), 0o755);
    }

    const env = {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
      PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    };

    await runNodeCapture([mobileScript, '--prebuild', '--platform=ios', '--profiling-runtime=memory', '--no-metro'], {
      cwd: rootDir,
      env,
    });

    const podfile = await readFile(join(uiDir, 'ios', 'Podfile'), 'utf8');
    assert.match(podfile, /use_expo_modules!\(\{ :exclude => \['expo-dev-client', 'expo-dev-launcher', 'expo-dev-menu', 'expo-dev-menu-interface'\] \}\)/);
    assert.match(
      podfile,
      /'react-native-config',[\s\S]*'--platform',\s*'ios',\s*'--exclude',\s*'expo-dev-client',\s*'expo-dev-launcher',\s*'expo-dev-menu',\s*'expo-dev-menu-interface'/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
