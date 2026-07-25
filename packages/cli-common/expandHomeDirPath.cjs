const { homedir } = require('node:os');
const { posix, win32 } = require('node:path');

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

function resolveHomeDirFromEnvironment(
  processEnv = process.env,
  platform = process.platform,
) {
  const envHome =
    platform === 'win32'
      ? (processEnv.USERPROFILE || processEnv.HOME)
      : processEnv.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

function expandHomeDirPath(
  value,
  processEnv = process.env,
  platform = process.platform,
) {
  if (value === '~') return resolveHomeDirFromEnvironment(processEnv, platform);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const api = pathApi(platform);
    const normalizedRelativePath = value
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean)
      .join(api.sep);
    return api.join(resolveHomeDirFromEnvironment(processEnv, platform), normalizedRelativePath);
  }
  return value;
}

module.exports = {
  expandHomeDirPath,
  resolveHomeDirFromEnvironment,
};
