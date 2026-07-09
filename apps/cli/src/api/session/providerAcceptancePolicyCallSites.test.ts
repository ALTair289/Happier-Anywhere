import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)));
const CLI_SRC_ROOT = resolve(REPO_ROOT, 'apps/cli/src');

function listProductionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = resolve(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      return listProductionTypeScriptFiles(absolute);
    }
    if (!entry.endsWith('.ts')) return [];
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts') || entry.endsWith('.integration.test.ts')) return [];
    return [absolute];
  });
}

function isExcludedCallSiteFile(absolute: string): boolean {
  const relativePath = relative(REPO_ROOT, absolute);
  return relativePath === 'apps/cli/src/api/session/sessionClient.ts'
    || relativePath === 'apps/cli/src/api/session/sessionClientPort.ts'
    || relativePath.startsWith('apps/cli/src/backends/claude/');
}

describe('provider acceptance policy call sites', () => {
  it('requires provider runtimes to choose pending materialization policy explicitly', () => {
    const implicitCallSites = listProductionTypeScriptFiles(CLI_SRC_ROOT).flatMap((absolute) => {
      if (isExcludedCallSiteFile(absolute)) return [];
      const source = readFileSync(absolute, 'utf8');
      const calls = [...source.matchAll(/deferDeliveredUserMessageWatermarkToProviderAcceptance(?:\?\.)?\(([\s\S]*?)\)/g)];

      return calls
        .filter((call) => !call[1]?.includes('pendingMaterialization'))
        .map((call) => `${relative(REPO_ROOT, absolute)}:${source.slice(0, call.index).split('\n').length}`);
    });

    expect(implicitCallSites).toEqual([]);
  });
});
