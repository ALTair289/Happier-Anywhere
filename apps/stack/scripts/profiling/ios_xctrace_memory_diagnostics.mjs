function includesPattern(text, pattern) {
  return pattern.test(String(text ?? ''));
}

function collectCodeSigningEvidence(unifiedLog) {
  const log = String(unifiedLog ?? '');
  return {
    codeValidityError67050: includesPattern(log, /Code validity check error:.*Code=-67050/i),
    amfiUnknownCertificateChain: includesPattern(log, /amfid.*adhoc signed or signed by an unknown certificate chain/i),
    detachedSignaturesMissing: includesPattern(log, /open\(\/private\/var\/db\/DetachedSignatures\).*No such file or directory/i),
  };
}

function hasCodeSigningEvidence(evidence) {
  return Boolean(
    evidence.codeValidityError67050 ||
      evidence.amfiUnknownCertificateChain ||
      evidence.detachedSignaturesMissing,
  );
}

function classifyRecordFailure(recordLog) {
  const log = String(recordLog ?? '');
  if (includesPattern(log, /Unable to instantiate loader for target/i)) {
    return 'target-loader-unavailable';
  }
  if (includesPattern(log, /Failed to acquire memory location for pushing shared memory into target/i)) {
    return 'target-shared-memory-injection-unavailable';
  }
  if (includesPattern(log, /Failed to load library .*liboainject\.dylib.*target process .* appears to have exited/i)) {
    return 'liboainject-target-exited';
  }
  if (includesPattern(log, /Target process is marked restricted and cannot be traced while System Integrity Protection is enabled/i)) {
    return 'sip-restricted-target';
  }
  if (includesPattern(log, /Recording failed with errors|Run issues were detected/i)) {
    return 'recording-failed';
  }
  return null;
}

function classifyExportFailure({ exportLog, tocBytes }) {
  const log = String(exportLog ?? '');
  if (tocBytes != null && Number(tocBytes) === 0) {
    return 'trace-export-unusable';
  }
  if (includesPattern(log, /Export failed|Document Missing Template Error|timed_out=1/i)) {
    return 'trace-export-unusable';
  }
  return null;
}

export function classifyXctraceMemoryDiagnostics({
  recordLog = '',
  exportLog = '',
  unifiedLog = '',
  tocBytes = null,
} = {}) {
  const codeSigningEvidence = collectCodeSigningEvidence(unifiedLog);
  const exportReason = classifyExportFailure({ exportLog, tocBytes });
  const recordReason = classifyRecordFailure(recordLog);
  const primaryReason = recordReason ?? exportReason ?? 'available';
  const available = primaryReason === 'available' && Number(tocBytes ?? 1) > 0;

  const recommendedNextStep = (() => {
    if (available) return 'export-and-parse-allocation-tables';
    if (
      primaryReason === 'target-loader-unavailable' ||
      primaryReason === 'target-shared-memory-injection-unavailable' ||
      primaryReason === 'liboainject-target-exited'
    ) {
      return hasCodeSigningEvidence(codeSigningEvidence)
        ? 'fix-instruments-target-code-signing-or-use-non-loader-memory-signal'
        : 'verify-xcode-instruments-loader-with-local-control';
    }
    if (primaryReason === 'trace-export-unusable') {
      return 'discard-failed-trace-and-use-bounded-xctrace-preflight';
    }
    if (primaryReason === 'sip-restricted-target') {
      return 'use-a-non-system-target-or-disable-sip-only-on-a-dedicated-profiling-machine';
    }
    return 'use-non-loader-memory-signal-and-capture-xcode-toolchain-diagnostics';
  })();

  return {
    available,
    primaryReason,
    codeSigningEvidence,
    recommendedNextStep,
  };
}
