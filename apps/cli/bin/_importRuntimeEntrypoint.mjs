import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { prepareRuntimeEntrypoint } from './_prepareRuntimeEntrypoint.mjs';
import { resolveValidRuntimeEntrypoint } from './_resolveRuntimeEntrypoint.mjs';

function isModuleResolutionFailure(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND';
}

function runtimeImportSpecifier(entrypoint, attempt) {
  const url = pathToFileURL(entrypoint);
  if (attempt > 0) {
    url.searchParams.set('happier_runtime_snapshot_retry', String(attempt));
  }
  return url.href;
}

async function waitForValidRuntimeEntrypoint(projectRoot, relativePath, opts) {
  const retryPollAttempts = Math.max(1, Number(opts.retryPollAttempts ?? 20));
  const retryDelayMs = Math.max(0, Number(opts.retryDelayMs ?? 5));
  for (let attempt = 0; attempt < retryPollAttempts; attempt += 1) {
    const entrypoint = resolveValidRuntimeEntrypoint(projectRoot, relativePath);
    if (entrypoint) return entrypoint;
    if (attempt + 1 < retryPollAttempts) {
      await (opts.delayImpl ?? delay)(retryDelayMs);
    }
  }
  return null;
}

export async function importPreparedRuntimeEntrypoint(projectRoot, relativePath, opts = {}) {
  const importModule = opts.importModule ?? ((specifier) => import(specifier));
  const entrypoint = await prepareRuntimeEntrypoint(projectRoot, relativePath, opts);

  try {
    return await importModule(runtimeImportSpecifier(entrypoint, 0));
  } catch (error) {
    if (!isModuleResolutionFailure(error)) {
      throw error;
    }

    const replacementEntrypoint = await waitForValidRuntimeEntrypoint(projectRoot, relativePath, opts);
    if (!replacementEntrypoint) {
      throw error;
    }
    return await importModule(runtimeImportSpecifier(replacementEntrypoint, 1));
  }
}
