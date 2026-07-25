import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-bun-runtime-'));
const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'migrations');
const migrationName = '20260101000000_partial';
const migrationDir = join(migrationsDir, migrationName);
const dbPath = join(root, 'happier.sqlite');

try {
  await mkdir(migrationDir, { recursive: true });
  await writeFile(
    join(migrationDir, 'migration.sql'),
    'CREATE TABLE Account(id INTEGER);\nCREATE TABLE IF NOT EXISTS Widget(id INTEGER);\n',
    'utf8',
  );

  const seed = new Database(dbPath);
  seed.exec('CREATE TABLE Account(id INTEGER);');
  seed.close();

  const migrationProcess = Bun.spawn({
    cmd: [process.execPath, 'run', 'sources/main.light.ts', '--migrate-only'],
    cwd: serverDir,
    env: {
      ...process.env,
      HAPPIER_SERVER_LIGHT_DATA_DIR: root,
      HAPPY_SERVER_LIGHT_DATA_DIR: root,
      HAPPIER_SQLITE_AUTO_MIGRATE: '0',
      HAPPIER_SQLITE_MIGRATIONS_DIR: migrationsDir,
      DATABASE_URL: `file:${dbPath}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    migrationProcess.exited,
    new Response(migrationProcess.stdout).text(),
    new Response(migrationProcess.stderr).text(),
  ]);

  if (exitCode === 0 || !stderr.includes('cannot be marked applied safely')) {
    throw new Error(
      [
        `Expected unsafe partial migration rejection from --migrate-only, exit=${exitCode}`,
        stdout.trim(),
        stderr.trim(),
      ].filter(Boolean).join('\n'),
    );
  }

  const inspection = new Database(dbPath, { readonly: true });
  try {
    const widget = inspection.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='Widget'`).get();
    if (widget != null) {
      throw new Error('Unsafe partial migration left Widget behind');
    }
    const ledger = inspection.query(
      'SELECT migration_name FROM _prisma_migrations WHERE migration_name = ?',
    ).get(migrationName);
    if (ledger != null) {
      throw new Error('Unsafe partial migration wrote a finished ledger row');
    }
  } finally {
    inspection.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
