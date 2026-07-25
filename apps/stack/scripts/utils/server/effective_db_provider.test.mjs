import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEffectiveDbProviderEnv,
  resolveEffectiveDbProvider,
  resolveEffectiveDbProviderTransition,
} from './effective_db_provider.mjs';

test('resolveEffectiveDbProvider applies the server-flavor defaults', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({ serverComponentName: 'happier-server-light', env: {} }),
    { ok: true, provider: 'sqlite', source: 'default' },
  );
  assert.deepEqual(
    resolveEffectiveDbProvider({ serverComponentName: 'happier-server', env: {} }),
    { ok: true, provider: 'postgres', source: 'default' },
  );
});

test('resolveEffectiveDbProvider normalizes provider names and env aliases', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({
      serverComponentName: 'happier-server-light',
      env: { HAPPY_DB_PROVIDER: ' PGLITE ' },
    }),
    { ok: true, provider: 'pglite', source: 'HAPPY_DB_PROVIDER' },
  );
  assert.deepEqual(
    resolveEffectiveDbProvider({
      serverComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: ' PostgreSQL ' },
    }),
    { ok: true, provider: 'postgres', source: 'HAPPIER_DB_PROVIDER' },
  );
});

test('resolveEffectiveDbProvider exposes unsupported explicit values without defaulting them', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({
      serverComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: ' postgres ' },
    }),
    {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName: 'happier-server-light',
      source: 'HAPPIER_DB_PROVIDER',
      input: 'postgres',
      supportedProviders: ['sqlite', 'pglite'],
    },
  );
});

test('resolveEffectiveDbProvider does not reinterpret an explicitly empty provider as a default', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({
      serverComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: '   ' },
    }),
    {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName: 'happier-server-light',
      source: 'HAPPIER_DB_PROVIDER',
      input: '',
      supportedProviders: ['sqlite', 'pglite'],
    },
  );
});

test('resolveEffectiveDbProvider rejects unsupported components instead of borrowing a flavor default', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({ serverComponentName: 'unknown-server', env: {} }),
    {
      ok: false,
      reason: 'unsupported_server_component',
      serverComponentName: 'unknown-server',
      supportedServerComponents: ['happier-server', 'happier-server-light'],
    },
  );
});

test('resolveEffectiveDbProvider gives the primary key precedence even when it is explicitly empty', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({
      serverComponentName: 'happier-server',
      env: {
        HAPPIER_DB_PROVIDER: '',
        HAPPY_DB_PROVIDER: 'postgresql',
      },
    }),
    {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName: 'happier-server',
      source: 'HAPPIER_DB_PROVIDER',
      input: '',
      supportedProviders: ['postgres', 'mysql'],
    },
  );
});

test('resolveEffectiveDbProvider accepts mysql only for the full server flavor', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({
      serverComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: ' MYSQL ' },
    }),
    { ok: true, provider: 'mysql', source: 'HAPPIER_DB_PROVIDER' },
  );
  assert.deepEqual(
    resolveEffectiveDbProvider({
      serverComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: 'mysql' },
    }),
    {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName: 'happier-server-light',
      source: 'HAPPIER_DB_PROVIDER',
      input: 'mysql',
      supportedProviders: ['sqlite', 'pglite'],
    },
  );
});

test('applyEffectiveDbProviderEnv materializes one canonical provider and rejects invalid input', () => {
  const fullEnv = {};
  assert.equal(
    applyEffectiveDbProviderEnv({ serverComponentName: 'happier-server', env: fullEnv }),
    'postgres',
  );
  assert.equal(fullEnv.HAPPIER_DB_PROVIDER, 'postgres');

  const aliasedEnv = { HAPPY_DB_PROVIDER: ' PostgreSQL ' };
  assert.equal(
    applyEffectiveDbProviderEnv({ serverComponentName: 'happier-server', env: aliasedEnv }),
    'postgres',
  );
  assert.equal(aliasedEnv.HAPPIER_DB_PROVIDER, 'postgres');

  assert.throws(
    () => applyEffectiveDbProviderEnv({
      serverComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'sqlite' },
    }),
    /unsupported DB provider/i,
  );
});

test('provider transition preserves compatible providers and MySQL authority', () => {
  const databaseUrl = 'mysql://operator:secret@db.example.test:3306/happier';
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'mysql', DATABASE_URL: databaseUrl },
    }),
    { ok: true, provider: 'mysql', databaseUrl, removeDatabaseUrl: false },
  );
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server-light',
      nextServerComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: 'pglite' },
    }),
    { ok: true, provider: 'pglite', databaseUrl: null, removeDatabaseUrl: false },
  );
});

test('provider transition defaults only after a component switch and fails closed for MySQL without authority', () => {
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server-light',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: '' },
    }),
    {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName: 'happier-server',
      source: 'HAPPIER_DB_PROVIDER',
      input: '',
      supportedProviders: ['postgres', 'mysql'],
    },
  );
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server-light',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'unknown' },
    }),
    {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName: 'happier-server',
      source: 'HAPPIER_DB_PROVIDER',
      input: 'unknown',
      supportedProviders: ['postgres', 'mysql'],
    },
  );
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: 'mysql', DATABASE_URL: 'mysql://old/db' },
    }),
    { ok: true, provider: 'sqlite', databaseUrl: null, removeDatabaseUrl: true },
  );
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'mysql' },
    }),
    { ok: false, reason: 'missing_mysql_database_url', provider: 'mysql' },
  );
});
