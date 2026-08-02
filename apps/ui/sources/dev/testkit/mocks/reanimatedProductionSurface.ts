import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads back the `react-native-reanimated` surface production code actually imports.
 *
 * `createReanimatedModuleMock()` is the single owner of that boundary under test: it backs both
 * the global `vi.mock` in `sources/dev/vitestSetup.ts` and the `reactNativeReanimatedStub`
 * alias. A missing export there is invisible until some suite renders the new call site, so the
 * factory's contract is checked against real import statements rather than a hand-kept list.
 *
 * Test-only: this module reads the repository from disk and must never be imported by app code
 * or re-exported from the `@/dev/testkit` barrel.
 */

const SOURCES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEV_ROOT = path.join(SOURCES_ROOT, 'dev');

const REANIMATED_IMPORT = /import\s+((?:(?!\bfrom\b)[\s\S])*?)\s*from\s+'react-native-reanimated'/g;

export type ReanimatedRuntimeImports = Readonly<{
    /** Named runtime imports, e.g. `useDerivedValue`, `measure`. Type-only imports are excluded. */
    namedImports: ReadonlySet<string>;
    /** Members read off the default export, e.g. `View` from `Animated.View`. */
    defaultMembers: ReadonlySet<string>;
    /** Production files that import the module at all — reported so an empty scan is not mistaken for a pass. */
    files: readonly string[];
}>;

function isScannableSourceFile(filePath: string): boolean {
    if (!/\.(ts|tsx)$/.test(filePath)) return false;
    if (/\.(test|spec)\.(ts|tsx)$/.test(filePath)) return false;
    if (filePath.includes('.generated.')) return false;
    return !filePath.startsWith(DEV_ROOT + path.sep);
}

function collectSourceFiles(directory: string, into: string[]): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            collectSourceFiles(entryPath, into);
            continue;
        }
        if (isScannableSourceFile(entryPath)) into.push(entryPath);
    }
}

function addNamedImports(clause: string, into: Set<string>): void {
    if (/^\s*type\s/.test(clause)) return;
    const braced = clause.match(/\{([\s\S]*?)\}/);
    if (!braced) return;
    for (const rawSpecifier of braced[1].split(',')) {
        const specifier = rawSpecifier.trim();
        if (!specifier || /^type\s/.test(specifier)) continue;
        const imported = specifier.split(/\s+as\s+/)[0].trim();
        if (imported) into.add(imported);
    }
}

function addDefaultMembers(clause: string, source: string, into: Set<string>): void {
    const withoutBraces = clause.replace(/\{[\s\S]*?\}/, '').replace(/^type\s+/, '');
    const localName = withoutBraces.split(',')[0].trim();
    if (!localName || !/^[A-Za-z_$][\w$]*$/.test(localName)) return;
    const memberAccess = new RegExp(`\\b${localName}\\.([A-Za-z_$][\\w$]*)`, 'g');
    let match: RegExpExecArray | null;
    while ((match = memberAccess.exec(source)) !== null) into.add(match[1]);
}

/**
 * Names re-exported by `sources/dev/reactNativeReanimatedStub.ts`, the module the vitest alias
 * resolves `react-native-reanimated` to. It mirrors the factory through a hand-written export
 * list, so it is a second place the surface can drift. It cannot be inspected by importing it —
 * the global `vi.mock` intercepts that specifier — so read the declarations from source.
 */
export function readReanimatedStubExportNames(): ReadonlySet<string> {
    const stubSource = fs.readFileSync(path.join(DEV_ROOT, 'reactNativeReanimatedStub.ts'), 'utf8');
    const names = new Set<string>();
    const exportedConst = /^export\s+const\s+([A-Za-z_$][\w$]*)/gm;
    let match: RegExpExecArray | null;
    while ((match = exportedConst.exec(stubSource)) !== null) names.add(match[1]);
    return names;
}

export function collectReanimatedRuntimeImports(): ReanimatedRuntimeImports {
    const sourceFiles: string[] = [];
    collectSourceFiles(SOURCES_ROOT, sourceFiles);

    const namedImports = new Set<string>();
    const defaultMembers = new Set<string>();
    const files: string[] = [];

    for (const filePath of sourceFiles) {
        const source = fs.readFileSync(filePath, 'utf8');
        if (!source.includes('react-native-reanimated')) continue;
        let importing = false;
        REANIMATED_IMPORT.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = REANIMATED_IMPORT.exec(source)) !== null) {
            importing = true;
            addNamedImports(match[1], namedImports);
            addDefaultMembers(match[1], source, defaultMembers);
        }
        if (importing) files.push(path.relative(SOURCES_ROOT, filePath));
    }

    return { namedImports, defaultMembers, files };
}
