import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyXctraceMemoryDiagnostics } from './ios_xctrace_memory_diagnostics.mjs';

test('classifyXctraceMemoryDiagnostics identifies loader injection failure with code validity evidence', () => {
  const result = classifyXctraceMemoryDiagnostics({
    recordLog: `
Run issues were detected:
* [Error] Failed to attach to target process
  * [Error] Unable to instantiate loader for target.
`,
    unifiedLog: `
com.apple.dt.instruments.dtsecurity Code validity check error: Error Domain=NSOSStatusErrorDomain Code=-67050 "(null)"
`,
  });

  assert.equal(result.available, false);
  assert.equal(result.primaryReason, 'target-loader-unavailable');
  assert.equal(result.codeSigningEvidence.codeValidityError67050, true);
  assert.equal(result.recommendedNextStep, 'fix-instruments-target-code-signing-or-use-non-loader-memory-signal');
});

test('classifyXctraceMemoryDiagnostics identifies launch-time shared-memory injection failure', () => {
  const result = classifyXctraceMemoryDiagnostics({
    recordLog: 'Failed to acquire memory location for pushing shared memory into target.',
  });

  assert.equal(result.available, false);
  assert.equal(result.primaryReason, 'target-shared-memory-injection-unavailable');
});

test('classifyXctraceMemoryDiagnostics identifies liboainject target-exit failure', () => {
  const result = classifyXctraceMemoryDiagnostics({
    recordLog: 'Failed to load library /Applications/Xcode.app/.../liboainject.dylib because target process 123 appears to have exited',
  });

  assert.equal(result.available, false);
  assert.equal(result.primaryReason, 'liboainject-target-exited');
});

test('classifyXctraceMemoryDiagnostics identifies unusable failed-trace exports', () => {
  const result = classifyXctraceMemoryDiagnostics({
    recordLog: 'Starting recording with the Allocations template.',
    exportLog: 'Export failed: Document Missing Template Error',
    tocBytes: 0,
  });

  assert.equal(result.available, false);
  assert.equal(result.primaryReason, 'trace-export-unusable');
});

test('classifyXctraceMemoryDiagnostics treats zero-byte TOC as unusable even without exporter stderr', () => {
  const result = classifyXctraceMemoryDiagnostics({
    exportLog: '',
    tocBytes: 0,
  });

  assert.equal(result.available, false);
  assert.equal(result.primaryReason, 'trace-export-unusable');
});

test('classifyXctraceMemoryDiagnostics reports success only when recording and export evidence are clean', () => {
  const result = classifyXctraceMemoryDiagnostics({
    recordLog: 'Recording completed successfully. Output file saved as: allocations.trace',
    tocBytes: 1024,
  });

  assert.equal(result.available, true);
  assert.equal(result.primaryReason, 'available');
  assert.equal(result.recommendedNextStep, 'export-and-parse-allocation-tables');
});
