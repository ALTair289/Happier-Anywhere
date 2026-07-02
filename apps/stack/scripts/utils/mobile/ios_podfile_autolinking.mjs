import { readFile, writeFile } from 'node:fs/promises';

export const IOS_MEMORY_PROFILING_AUTOLINKING_EXCLUDES = [
  'expo-dev-client',
  'expo-dev-launcher',
  'expo-dev-menu',
  'expo-dev-menu-interface',
];

function toRubyStringArray(values) {
  return `[${values.map((value) => `'${String(value).replaceAll("'", "\\'")}'`).join(', ')}]`;
}

function hasAllExcludedModules(source, modules) {
  return modules.every((moduleName) => source.includes(`'${moduleName}'`));
}

function patchExpoModulesAutolinking(source, modules) {
  if (/use_expo_modules!\s*\(\s*\{[^)]*:exclude\s*=>/.test(source) && hasAllExcludedModules(source, modules)) {
    return source;
  }
  const rubyArray = toRubyStringArray(modules);
  const next = source.replace(/^(\s*)use_expo_modules!\s*$/m, `$1use_expo_modules!({ :exclude => ${rubyArray} })`);
  if (next === source) {
    throw new Error('Could not find the generated bare use_expo_modules! call in ios/Podfile.');
  }
  return next;
}

function patchReactNativeConfigAutolinking(source, modules) {
  const reactNativeConfigIndex = source.indexOf("'react-native-config'");
  if (reactNativeConfigIndex === -1) {
    throw new Error('Could not find react-native-config autolinking command in ios/Podfile.');
  }
  const nextArrayEnd = source.indexOf('\n    ]', reactNativeConfigIndex);
  if (nextArrayEnd === -1) {
    throw new Error('Could not find the end of the react-native-config autolinking command in ios/Podfile.');
  }
  const commandBlock = source.slice(reactNativeConfigIndex, nextArrayEnd);
  if (commandBlock.includes("'--exclude'") && hasAllExcludedModules(commandBlock, modules)) {
    return source;
  }

  const beforeEnd = source.slice(0, nextArrayEnd);
  const afterEnd = source.slice(nextArrayEnd);
  const trimmedBeforeEnd = beforeEnd.replace(/(\s*'ios')\s*$/, `$1,\n      '--exclude',\n${modules.map((moduleName) => `      '${moduleName}'`).join(',\n')}`);
  if (trimmedBeforeEnd === beforeEnd) {
    throw new Error('Could not find the iOS platform marker in the react-native-config autolinking command.');
  }
  return `${trimmedBeforeEnd}${afterEnd}`;
}

export async function patchIosPodfileAutolinkingForMemoryProfiling({
  uiDir,
  excludedModules = IOS_MEMORY_PROFILING_AUTOLINKING_EXCLUDES,
} = {}) {
  const projectDir = String(uiDir ?? '').trim();
  if (!projectDir) {
    throw new Error('patchIosPodfileAutolinkingForMemoryProfiling requires uiDir.');
  }
  const modules = [...new Set(excludedModules.map((name) => String(name).trim()).filter(Boolean))];
  if (modules.length === 0) {
    throw new Error('patchIosPodfileAutolinkingForMemoryProfiling requires at least one excluded module.');
  }

  const podfilePath = `${projectDir}/ios/Podfile`;
  const raw = await readFile(podfilePath, 'utf-8');
  const next = patchReactNativeConfigAutolinking(patchExpoModulesAutolinking(raw, modules), modules);
  if (next === raw) {
    return { changed: false, podfilePath, excludedModules: modules };
  }
  await writeFile(podfilePath, next, 'utf-8');
  return { changed: true, podfilePath, excludedModules: modules };
}
