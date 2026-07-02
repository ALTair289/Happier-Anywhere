export const IOS_PROFILING_RUNTIME_MODE = {
  off: 'off',
  standard: 'standard',
  memory: 'memory',
};

function normalizeProfilingRuntimeMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return IOS_PROFILING_RUNTIME_MODE.standard;
  }
  if (normalized === IOS_PROFILING_RUNTIME_MODE.standard || normalized === 'cpu') {
    return IOS_PROFILING_RUNTIME_MODE.standard;
  }
  if (normalized === IOS_PROFILING_RUNTIME_MODE.memory || normalized === 'memory-attribution' || normalized === 'allocations') {
    return IOS_PROFILING_RUNTIME_MODE.memory;
  }
  throw new Error(`Unsupported iOS profiling runtime mode "${value}". Use --profiling-runtime or --profiling-runtime=memory.`);
}

export function resolveIosProfilingRuntimeMode({ flags, kv } = {}) {
  if (flags?.has('--memory-attribution')) return IOS_PROFILING_RUNTIME_MODE.memory;
  if (kv?.has('--profiling-runtime')) return normalizeProfilingRuntimeMode(kv.get('--profiling-runtime'));
  if (kv?.has('--profiling')) return normalizeProfilingRuntimeMode(kv.get('--profiling'));
  if (flags?.has('--profiling-runtime') || flags?.has('--profiling')) return IOS_PROFILING_RUNTIME_MODE.standard;
  return IOS_PROFILING_RUNTIME_MODE.off;
}

export function isIosProfilingRuntimeEnabled(mode) {
  return mode === IOS_PROFILING_RUNTIME_MODE.standard || mode === IOS_PROFILING_RUNTIME_MODE.memory;
}

export function isIosMemoryAttributionRuntime(mode) {
  return mode === IOS_PROFILING_RUNTIME_MODE.memory;
}
