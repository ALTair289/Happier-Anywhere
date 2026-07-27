import {
  listCursorAvailableModels,
  type AcpExtensionRequester,
} from './listAvailableModels';
import type { CursorAvailableModel } from './schemas';

const DEFAULT_TIMEOUT_MS = 5_000;

export class CursorAvailableModelsContribution {
  private generation = 0;
  private models: ReadonlyArray<CursorAvailableModel> | null = null;

  constructor(private readonly options: Readonly<{
    onChange: (models: ReadonlyArray<CursorAvailableModel> | null) => void;
    timeoutMs?: number;
  }>) {}

  beginGeneration(): number {
    this.generation += 1;
    this.replace(null);
    return this.generation;
  }

  invalidate(): void {
    this.beginGeneration();
  }

  current(): ReadonlyArray<CursorAvailableModel> | null {
    return this.models;
  }

  async discover(generation: number, request: AcpExtensionRequester): Promise<void> {
    try {
      const models = await listCursorAvailableModels({
        request,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (generation !== this.generation) return;
      this.replace(models.length > 0 ? models : null);
    } catch {
      if (generation !== this.generation) return;
      this.replace(null);
    }
  }

  private replace(models: ReadonlyArray<CursorAvailableModel> | null): void {
    this.models = models;
    this.options.onChange(models);
  }
}
