import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEasBuildProfileEnv } from '../../../scripts/pipeline/expo/resolve-eas-build-profile-env.mjs';

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const uiDir = path.resolve(path.dirname(scriptPath), '..');
const defaultEasJsonPath = path.join(uiDir, 'eas.json');

export function createPublicdevDevClientIosPlan({
  easJsonPath = defaultEasJsonPath,
  forwardedArgs = [],
} = {}) {
  const profileEnv = resolveEasBuildProfileEnv({
    easJsonPath,
    profileId: 'publicdev-dev-client',
  });

  return {
    env: {
      ...profileEnv,
      HAPPIER_UI_METRO_DISABLE_WATCHMAN: '1',
      SENTRY_DISABLE_AUTO_UPLOAD: 'true',
    },
    commands: [
      ['prebuild', '--clean', '--platform', 'ios'],
      ['run:ios', ...forwardedArgs.map(String)],
    ],
  };
}

export function runPublicdevDevClientIos({
  forwardedArgs = process.argv.slice(2),
  easJsonPath = defaultEasJsonPath,
  inheritedEnv = process.env,
  spawn = spawnSync,
} = {}) {
  const plan = createPublicdevDevClientIosPlan({ easJsonPath, forwardedArgs });
  const expoCliPath = require.resolve('expo/bin/cli');
  const env = { ...inheritedEnv, ...plan.env };

  for (const commandArgs of plan.commands) {
    const result = spawn(process.execPath, [expoCliPath, ...commandArgs], {
      cwd: uiDir,
      env,
      stdio: 'inherit',
    });

    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }

  return 0;
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    process.exitCode = runPublicdevDevClientIos();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
