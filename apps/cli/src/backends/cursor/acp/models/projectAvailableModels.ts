import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import type { CursorSessionModelsFromConfigOptions } from '@/backends/cursor/acp/cursorModelConfigTypes';

import type { CursorAvailableModel } from './schemas';

function mergeOptions(
  primary: ReadonlyArray<SessionConfigOption> | undefined,
  secondary: ReadonlyArray<SessionConfigOption> | undefined,
): ReadonlyArray<SessionConfigOption> | undefined {
  const merged: SessionConfigOption[] = [];
  const seen = new Set<string>();
  for (const option of [...(primary ?? []), ...(secondary ?? [])]) {
    if (!option.id.trim() || seen.has(option.id)) continue;
    seen.add(option.id);
    merged.push(option);
  }
  return merged.length > 0 ? merged : undefined;
}

export function projectCursorAvailableModels(params: Readonly<{
  proprietaryModels: ReadonlyArray<CursorAvailableModel>;
  standardProjection: CursorSessionModelsFromConfigOptions | null;
}>): CursorSessionModelsFromConfigOptions | null {
  const models: CursorSessionModelsFromConfigOptions['availableModels'][number][] = [];
  const indexById = new Map<string, number>();

  for (const model of params.proprietaryModels) {
    if (indexById.has(model.value)) continue;
    indexById.set(model.value, models.length);
    models.push({
      id: model.value,
      name: model.name,
      ...(model.configOptions && model.configOptions.length > 0
        ? { modelOptions: model.configOptions }
        : {}),
    });
  }

  for (const standardModel of params.standardProjection?.availableModels ?? []) {
    const existingIndex = indexById.get(standardModel.id);
    if (existingIndex === undefined) {
      indexById.set(standardModel.id, models.length);
      models.push(standardModel);
      continue;
    }
    const existing = models[existingIndex]!;
    const modelOptions = mergeOptions(existing.modelOptions, standardModel.modelOptions);
    if (modelOptions) models[existingIndex] = { ...existing, modelOptions };
  }

  if (models.length === 0) return params.standardProjection;
  const standardCurrent = params.standardProjection?.currentModelId;
  const currentModelId = standardCurrent && indexById.has(standardCurrent)
    ? standardCurrent
    : models[0]!.id;
  return { currentModelId, availableModels: models };
}
