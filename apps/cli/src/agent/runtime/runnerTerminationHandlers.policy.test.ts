import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(path);
    }
    if (!entry.name.endsWith('.ts')) return [];
    if (entry.name.endsWith('.d.ts')) return [];
    if (entry.name.includes('.test.')) return [];
    if (entry.name.includes('.integration.')) return [];
    if (entry.name.includes('.slow.')) return [];
    return [path];
  }));
  return files.flat();
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function collectRunnerRegistrationsMissingExitReport(params: Readonly<{ rootDir: string; filePath: string; text: string }>): string[] {
  const source = ts.createSourceFile(params.filePath, params.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const missing: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'registerRunnerTerminationHandlers'
    ) {
      const [firstArg] = node.arguments;
      const hasSessionExitReport = ts.isObjectLiteralExpression(firstArg)
        && firstArg.properties.some((property) => propertyNameText(property.name) === 'sessionExitReport');
      if (!hasSessionExitReport) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        missing.push(`${relative(params.rootDir, params.filePath)}:${line + 1}`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return missing;
}

describe('runner termination handler wiring policy', () => {
  it('records semantic exit reports for every production runner registration', async () => {
    const rootDir = fileURLToPath(new URL('../../', import.meta.url));
    const scanDirs = [
      fileURLToPath(new URL('../../agent', import.meta.url)),
      fileURLToPath(new URL('../../backends', import.meta.url)),
    ];
    const sourceFiles = (await Promise.all(scanDirs.map((dir) => collectSourceFiles(dir)))).flat();

    const missing: string[] = [];
    for (const filePath of sourceFiles) {
      const text = await readFile(filePath, 'utf8');
      if (!text.includes('registerRunnerTerminationHandlers')) continue;
      missing.push(
        ...collectRunnerRegistrationsMissingExitReport({
          rootDir,
          filePath,
          text,
        }),
      );
    }

    expect(missing).toEqual([]);
  });
});
