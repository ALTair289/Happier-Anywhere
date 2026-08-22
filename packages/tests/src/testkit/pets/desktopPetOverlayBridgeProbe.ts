import type { Page } from '@playwright/test';

export type DesktopPetOverlayBridgeInvocation = Readonly<{
  command: string;
  args?: Record<string, unknown>;
}>;

export const desktopPetOverlayBridgeInvocationKey =
  '__HAPPIER_E2E_DESKTOP_PET_OVERLAY_BRIDGE_INVOCATIONS__' as const;

export type DesktopPetOverlayProbeWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  [desktopPetOverlayBridgeInvocationKey]?: DesktopPetOverlayBridgeInvocation[];
};

export type DesktopPetOverlayBridgeProbeOptions = Readonly<{
  windowState?: unknown;
}>;

export function createDesktopPetOverlayBridgeProbeInitScript(): (
  options?: DesktopPetOverlayBridgeProbeOptions,
) => void {
  return (options) => {
    const invocationKey = '__HAPPIER_E2E_DESKTOP_PET_OVERLAY_BRIDGE_INVOCATIONS__' as const;
    const target = window as DesktopPetOverlayProbeWindow;
    const existingInvoke = target.__TAURI_INTERNALS__?.invoke;
    const windowState = options?.windowState ?? {
      activity: {
        state: 'idle',
        reason: 'idle',
        sessionId: null,
        trayItems: [],
      },
    };
    target[invocationKey] = [];
    target.__TAURI_INTERNALS__ = {
      ...(target.__TAURI_INTERNALS__ ?? {}),
      invoke: async (command: string, args?: Record<string, unknown>) => {
        target[invocationKey]?.push({ command, args });
        if (existingInvoke) return existingInvoke(command, args);
        if (command === 'desktop_pet_overlay_read_window_state') return windowState;
        return null;
      },
    };
  };
}

export async function installDesktopPetOverlayBridgeProbe(
  page: Pick<Page, 'addInitScript'>,
  options: DesktopPetOverlayBridgeProbeOptions = {},
): Promise<void> {
  await page.addInitScript(createDesktopPetOverlayBridgeProbeInitScript(), options);
}

export async function readDesktopPetOverlayBridgeInvocations(
  page: Pick<Page, 'evaluate'>,
): Promise<DesktopPetOverlayBridgeInvocation[]> {
  return page.evaluate((key) => {
    const target = window as DesktopPetOverlayProbeWindow;
    return [...(target[key] ?? [])];
  }, desktopPetOverlayBridgeInvocationKey);
}
