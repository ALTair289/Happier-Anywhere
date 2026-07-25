export const DEV_SERVER_SHARED_RUNTIME_PACKAGE_IDS = Object.freeze([
  'agents',
  'cli-common',
  'protocol',
]);

const DEV_SERVER_SHARED_RUNTIME_PACKAGE_ID_SET = new Set(DEV_SERVER_SHARED_RUNTIME_PACKAGE_IDS);

export function isDevServerSharedRuntimePackageId(packageId) {
  return DEV_SERVER_SHARED_RUNTIME_PACKAGE_ID_SET.has(packageId);
}
