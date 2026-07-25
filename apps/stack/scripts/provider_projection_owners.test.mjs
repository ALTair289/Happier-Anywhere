import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDbProviderForLightFromEnv } from './auth.mjs';
import { probeExistingAccountCountForServerComponent } from './utils/stack/startup.mjs';

test('auth light provider projection rejects cross-flavor input through the canonical owner', () => {
  assert.equal(resolveDbProviderForLightFromEnv({}), 'sqlite');
  assert.equal(resolveDbProviderForLightFromEnv({ HAPPY_DB_PROVIDER: ' PGLITE ' }), 'pglite');
  assert.throws(
    () => resolveDbProviderForLightFromEnv({ HAPPIER_DB_PROVIDER: 'mysql' }),
    /unsupported DB provider/i,
  );
});

test('startup account projection surfaces canonical provider rejection before probing', async () => {
  const result = await probeExistingAccountCountForServerComponent({
    serverComponentName: 'happier-server-light',
    serverDir: '/unused',
    env: { HAPPIER_DB_PROVIDER: 'postgres' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported DB provider/i);
});
