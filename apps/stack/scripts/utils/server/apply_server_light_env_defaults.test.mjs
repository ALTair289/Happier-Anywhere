import assert from 'node:assert/strict';
import test from 'node:test';

import { applyServerLightEnvDefaults } from './apply_server_light_env_defaults.mjs';

test('applyServerLightEnvDefaults expands ~/ light-server path overrides against HOME', () => {
  const serverEnv = {};

  applyServerLightEnvDefaults({
    baseEnv: {
      HOME: '/scoped/home',
      HAPPIER_SERVER_LIGHT_DATA_DIR: '~/server-light',
      HAPPIER_SERVER_LIGHT_FILES_DIR: '~/server-light/files-override',
      HAPPIER_SERVER_LIGHT_DB_DIR: '~/server-light/db-override',
    },
    serverEnv,
    baseDir: '/stack/base',
  });

  assert.deepEqual(serverEnv, {
    HAPPIER_DB_PROVIDER: 'sqlite',
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/scoped/home/server-light',
    HAPPIER_SERVER_LIGHT_FILES_DIR: '/scoped/home/server-light/files-override',
    HAPPIER_SERVER_LIGHT_DB_DIR: '/scoped/home/server-light/db-override',
  });
});

test('applyServerLightEnvDefaults writes normalized explicit light DB providers', () => {
  for (const [input, expected] of [[' PGLITE ', 'pglite'], [' SQLITE ', 'sqlite']]) {
    const serverEnv = {};

    applyServerLightEnvDefaults({
      baseEnv: { HAPPIER_DB_PROVIDER: input },
      serverEnv,
      baseDir: '/stack/base',
    });

    assert.equal(serverEnv.HAPPIER_DB_PROVIDER, expected);
  }
});

test('applyServerLightEnvDefaults rejects an unsupported explicit DB provider', () => {
  assert.throws(
    () => applyServerLightEnvDefaults({
      baseEnv: { HAPPIER_DB_PROVIDER: 'unsupported' },
      serverEnv: {},
      baseDir: '/stack/base',
    }),
    /unsupported DB provider/i,
  );
});

test('applyServerLightEnvDefaults clears inherited DATABASE_URL before local light authority is derived', () => {
  const serverEnv = { DATABASE_URL: 'mysql://exported-shell/db' };
  applyServerLightEnvDefaults({
    baseEnv: { HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'mysql://exported-shell/db' },
    serverEnv,
    baseDir: '/stack/base',
  });
  assert.equal(Object.hasOwn(serverEnv, 'DATABASE_URL'), false);
});
