import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveTypeScriptCliPath } from '../../../scripts/workspaces/typescriptCommand.mjs';

describe('server runtime TypeScript inputs', () => {
    it('admits test-only errors while full typecheck rejects them and runtime errors still fail', () => {
        const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-server-runtime-tsconfig-'));
        try {
            const runtimeConfig = JSON.parse(readFileSync(join(serverDir, 'tsconfig.runtime.json'), 'utf8')) as {
                include?: string[];
                exclude?: string[];
            };
            mkdirSync(join(fixtureDir, 'sources', 'testkit'), { recursive: true });
            mkdirSync(join(fixtureDir, 'sources', 'storage'), { recursive: true });
            mkdirSync(join(fixtureDir, 'sources', 'types'), { recursive: true });
            writeFileSync(
                join(fixtureDir, 'sources', 'main.ts'),
                "import type { Database } from 'bun:sqlite';\nimport './runtime';\nexport const ambient: PrismaJson.RuntimeValue = 'valid';\nexport type RuntimeDatabase = Database;\n",
                'utf8',
            );
            writeFileSync(join(fixtureDir, 'sources', 'main.light.ts'), "import './runtime';\n", 'utf8');
            writeFileSync(join(fixtureDir, 'sources', 'runtime.ts'), 'export const runtime: string = "valid";\n', 'utf8');
            writeFileSync(
                join(fixtureDir, 'sources', 'storage', 'types.ts'),
                "declare global { namespace PrismaJson { type RuntimeValue = string; } }\nexport {};\n",
                'utf8',
            );
            writeFileSync(
                join(fixtureDir, 'sources', 'types', 'bun-sqlite.d.ts'),
                "declare module 'bun:sqlite' { export class Database {} }\n",
                'utf8',
            );
            writeFileSync(
                join(fixtureDir, 'sources', 'testkit', 'runtimeHarness.ts'),
                'export const testOnly: string = 1;\n',
                'utf8',
            );
            writeFileSync(join(fixtureDir, 'tsconfig.runtime.json'), JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    target: 'ESNext',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                },
                include: runtimeConfig.include,
                exclude: runtimeConfig.exclude,
            }), 'utf8');
            writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    target: 'ESNext',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                },
                include: ['sources/**/*.ts', 'sources/**/*.tsx'],
                exclude: ['node_modules'],
            }), 'utf8');

            const compiler = resolveTypeScriptCliPath({ cwd: serverDir });
            const runtimeTypecheck = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.runtime.json'], {
                cwd: fixtureDir,
                encoding: 'utf8',
            });
            expect(runtimeTypecheck.status, runtimeTypecheck.stderr || runtimeTypecheck.stdout).toBe(0);

            const fullTypecheck = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json'], {
                cwd: fixtureDir,
                encoding: 'utf8',
            });
            expect(fullTypecheck.status).not.toBe(0);
            expect(`${fullTypecheck.stdout}\n${fullTypecheck.stderr}`).toContain('runtimeHarness.ts');

            writeFileSync(join(fixtureDir, 'sources', 'runtime.ts'), 'export const runtime: string = 1;\n', 'utf8');
            const runtimeError = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.runtime.json'], {
                cwd: fixtureDir,
                encoding: 'utf8',
            });
            expect(runtimeError.status).not.toBe(0);
            expect(`${runtimeError.stdout}\n${runtimeError.stderr}`).toContain('runtime.ts');
        } finally {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
    });
});
