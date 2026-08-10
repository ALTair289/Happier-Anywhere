import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAssemblyCliArgs } from '../pipeline/deployment-kit/assemble-deployment-kit.mjs';

test('deployment kit assembly CLI accepts only explicit spec and output paths', () => {
  assert.deepEqual(
    parseAssemblyCliArgs(['--spec', 'kit-spec.json', '--out=dist/my-kit']),
    { help: false, specPath: 'kit-spec.json', outDir: 'dist/my-kit' },
  );
  assert.deepEqual(parseAssemblyCliArgs(['--help']), { help: true, specPath: null, outDir: null });
});

test('deployment kit assembly CLI rejects missing, duplicate, and ambient-looking arguments', () => {
  assert.throws(() => parseAssemblyCliArgs(['--spec', 'kit.json']), /--out/);
  assert.throws(
    () => parseAssemblyCliArgs(['--spec', 'one.json', '--spec', 'two.json', '--out', 'kit']),
    /duplicate.*--spec/i,
  );
  assert.throws(
    () => parseAssemblyCliArgs(['--spec', 'kit.json', '--out', 'kit', '--channel', 'stable']),
    /unknown argument/i,
  );
});
