import type { SessionConfigOption } from '@/agent/acp/AcpBackend';

import type {
  CursorSessionConfigOptionUpdate,
  CursorSessionModelConfigUpdate,
} from './cursorModelConfigTypes';
import {
  findBooleanConfigValue,
  findConfigOption,
  findCursorModelConfigOption,
  findDefaultModelChoice,
  findRealConfigOption,
  findRealConfigOptionByControlId,
  findSelectOptionValue,
  modelChoiceBaseMatches,
  normalizeDirectConfigOptionUpdateValue,
  normalizeSessionConfigUpdateValue,
} from './cursorModelConfigLookup';
import {
  formatParameterizedModelValue,
  normalizeCursorModelVariantBaseId,
  normalizeToken,
  parseCursorCliTraits,
  parseParameterizedModelValue,
  stringifyConfigValue,
  stripParameterizedSuffix,
} from './cursorModelConfigParsing';
import {
  modelParamControlId,
  pickCursorReasoningParamKey,
  toDisplayModelId,
} from './cursorModelConfigControls';
import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';

function resolveExactParameterizedChoice(params: Readonly<{
  choices: NonNullable<SessionConfigOption['options']>;
  baseChoice: NonNullable<SessionConfigOption['options']>[number];
  traits: ReturnType<typeof parseCursorCliTraits>;
}>): string | undefined {
  const parsed = parseParameterizedModelValue(stringifyConfigValue(params.baseChoice.value));
  const nextParams = new Map(parsed.params);
  let changed = false;

  if (params.traits.contextWindow && nextParams.has('context')) {
    nextParams.set('context', params.traits.contextWindow);
    changed = true;
  }
  if (params.traits.reasoning) {
    nextParams.set(pickCursorReasoningParamKey(parsed.base, nextParams), params.traits.reasoning);
    changed = true;
  }
  if (typeof params.traits.fastMode === 'boolean' && nextParams.has('fast')) {
    nextParams.set('fast', String(params.traits.fastMode));
    changed = true;
  }
  if (typeof params.traits.thinking === 'boolean' && nextParams.has('thinking')) {
    nextParams.set('thinking', String(params.traits.thinking));
    changed = true;
  }
  if (!changed) return undefined;

  const candidate = formatParameterizedModelValue({
    base: parsed.base,
    params: nextParams,
    order: parsed.order,
  });
  const exact = params.choices.find((choice) => choice.value === candidate)?.value;
  return exact === undefined ? undefined : stringifyConfigValue(exact);
}

function pushConfigUpdate(
  updates: Array<Readonly<{ configId: string; value: string | number | boolean | null }>>,
  option: SessionConfigOption | undefined,
  value: string | boolean | undefined,
): void {
  if (!option || value === undefined) return;
  updates.push({
    configId: option.id,
    value,
  });
}

function findExactModelChoiceWithParam(params: Readonly<{
  choices: NonNullable<SessionConfigOption['options']>;
  currentModelValue: string;
  configId: string;
  value: string | number | boolean | null;
}>): string | undefined {
  const requestedControlId = modelParamControlId(params.configId);
  const requestedValue = stringifyConfigValue(params.value);
  if (!requestedControlId || !requestedValue) return undefined;

  const currentParsed = parseParameterizedModelValue(params.currentModelValue);
  const currentDisplayId = toDisplayModelId(params.currentModelValue);
  const requestedParams = new Map(currentParsed.params);
  const existingParamKey = Array.from(requestedParams.keys()).find((key) => modelParamControlId(key) === requestedControlId);
  const targetParamKey = existingParamKey ?? (requestedControlId === 'reasoning_effort'
    ? pickCursorReasoningParamKey(currentParsed.base, requestedParams)
    : requestedControlId);
  requestedParams.set(targetParamKey, requestedValue);

  return params.choices
    .map((choice) => stringifyConfigValue(choice.value))
    .find((choiceValue) => {
      if (toDisplayModelId(choiceValue) !== currentDisplayId) return false;
      const candidate = parseParameterizedModelValue(choiceValue);
      for (const [key, value] of requestedParams) {
        if (candidate.params.get(key) !== value) return false;
      }
      return true;
    });
}

export function resolveCursorSessionConfigOptionUpdate(params: Readonly<{
  configId: string;
  value: string | number | boolean | null;
  configOptions: ReadonlyArray<SessionConfigOption> | null;
}>): CursorSessionConfigOptionUpdate {
  const configId = readNonBlankSessionControlIdentifier(params.configId) ?? '';
  const value = normalizeSessionConfigUpdateValue(params.value);
  if (!params.configOptions || params.configOptions.length === 0 || !configId || value === undefined) {
    return { configId, value: value ?? null };
  }
  const realConfigOption = findRealConfigOption(params.configOptions, configId);
  if (realConfigOption) {
    return { configId, value: normalizeDirectConfigOptionUpdateValue(realConfigOption, value) };
  }
  const realConfigOptionByControlId = findRealConfigOptionByControlId(params.configOptions, configId);
  if (realConfigOptionByControlId) {
    return {
      configId: realConfigOptionByControlId.id,
      value: normalizeDirectConfigOptionUpdateValue(realConfigOptionByControlId, value),
    };
  }

  const modelOption = findCursorModelConfigOption(params.configOptions);
  const choices = modelOption?.options;
  const currentModelValue = modelOption ? stringifyConfigValue(modelOption.currentValue) : '';
  if (!choices || choices.length === 0 || !currentModelValue) return { configId, value };

  const exactModelId = findExactModelChoiceWithParam({
    choices,
    currentModelValue,
    configId,
    value,
  });

  return exactModelId ? { modelId: exactModelId } : null;
}

export function resolveCursorSessionModelConfigUpdate(params: Readonly<{
  modelId: string;
  configOptions: ReadonlyArray<SessionConfigOption> | null;
}>): CursorSessionModelConfigUpdate {
  const requestedModelId = readNonBlankSessionControlIdentifier(params.modelId) ?? '';
  if (!requestedModelId || !params.configOptions || params.configOptions.length === 0) {
    return { modelId: requestedModelId };
  }

  const modelOption = findCursorModelConfigOption(params.configOptions);
  const modelChoices = modelOption?.options;
  if (!modelChoices || modelChoices.length === 0) {
    return { modelId: requestedModelId };
  }

  const exactChoice = modelChoices.find((choice) => choice.value === requestedModelId);
  if (exactChoice) return { modelId: stringifyConfigValue(exactChoice.value) };

  if (normalizeToken(requestedModelId) === 'auto' || normalizeToken(requestedModelId) === 'default') {
    const defaultChoice = findDefaultModelChoice(modelChoices);
    if (defaultChoice) return { modelId: stringifyConfigValue(defaultChoice.value) };
  }

  const requestedBase = stripParameterizedSuffix(requestedModelId);
  const requestedBases = new Set([
    requestedBase,
    normalizeCursorModelVariantBaseId(requestedBase),
  ]);
  const baseChoice = modelChoices.find((choice) => modelChoiceBaseMatches(choice.value, requestedBases));
  if (!baseChoice) return null;

  const traits = parseCursorCliTraits(requestedModelId);
  const exactParameterizedChoice = resolveExactParameterizedChoice({
    choices: modelChoices,
    baseChoice,
    traits,
  });
  if (exactParameterizedChoice) return { modelId: exactParameterizedChoice };

  const updates: Array<Readonly<{ configId: string; value: string | number | boolean | null }>> = [];
  if (traits.contextWindow) {
    const contextOption = findConfigOption(params.configOptions, ['context', 'context-size', 'context_size', 'context-window', 'context_window'], ['context']);
    pushConfigUpdate(updates, contextOption, findSelectOptionValue(contextOption, traits.contextWindow));
  }

  if (traits.reasoning) {
    const reasoningOption = findConfigOption(params.configOptions, ['reasoning', 'effort', 'thought-level', 'thought_level', 'reasoning-effort', 'reasoning_effort'], ['reasoning', 'effort', 'thought']);
    pushConfigUpdate(updates, reasoningOption, findSelectOptionValue(reasoningOption, traits.reasoning));
  }

  if (typeof traits.fastMode === 'boolean') {
    const fastOption = findConfigOption(params.configOptions, ['fast'], ['fast', 'fast-mode']);
    pushConfigUpdate(updates, fastOption, findBooleanConfigValue(fastOption, traits.fastMode));
  }

  if (typeof traits.thinking === 'boolean') {
    const thinkingOption = findConfigOption(params.configOptions, ['thinking'], ['thinking']);
    pushConfigUpdate(updates, thinkingOption, findBooleanConfigValue(thinkingOption, traits.thinking));
  }

  return {
    modelId: stringifyConfigValue(baseChoice.value),
    ...(updates.length > 0 ? { configUpdates: updates } : {}),
  };
}
