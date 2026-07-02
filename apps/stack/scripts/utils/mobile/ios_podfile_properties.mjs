import { readFile, writeFile } from 'node:fs/promises';

export async function patchIosPodfilePropertiesForMobileBuild({ uiDir, memoryAttribution = false }) {
  const podPropsPath = `${uiDir}/ios/Podfile.properties.json`;
  try {
    const raw = await readFile(podPropsPath, 'utf-8');
    const json = JSON.parse(raw);
    json['ios.deploymentTarget'] = '16.0';
    json['ios.buildReactNativeFromSource'] = 'true';
    if (memoryAttribution) {
      json.EX_DEV_CLIENT_NETWORK_INSPECTOR = 'false';
    }
    await writeFile(podPropsPath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
