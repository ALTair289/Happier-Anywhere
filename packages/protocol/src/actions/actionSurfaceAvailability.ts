import type { ActionId } from './actionIds.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { isActionEnabledByActionsSettings, type ActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec, type ActionSpec, type ActionSurfaces, type ActionToolExposureSurface } from './actionSpecs.js';

export const ACTION_TOOL_EXPOSURE_SURFACES = ['session_agent', 'mcp', 'cli'] as const satisfies readonly ActionToolExposureSurface[];

const ACTION_SURFACES = [
  'ui_button',
  'ui_slash_command',
  'voice_tool',
  'voice_action_block',
  'session_agent',
  'mcp',
  'cli',
] as const satisfies readonly (keyof ActionSurfaces)[];

const ACTION_TOOL_EXPOSURE_SURFACE_SET = new Set<string>(ACTION_TOOL_EXPOSURE_SURFACES);

export type ActionSurfaceAvailabilityReason =
  | 'available'
  | 'unknown_action'
  | 'missing_tool_binding'
  | 'unsupported_surface'
  | 'disabled_by_settings'
  | 'disabled_by_policy';

export type ActionSurfaceSettingsState = 'enabled' | 'disabled' | 'approval_required' | 'unknown';

export type ActionSurfaceAvailability = Readonly<{
  available: boolean;
  reason: ActionSurfaceAvailabilityReason;
  actionId: string;
  surface: keyof ActionSurfaces | null;
  availableSurfaces: readonly (keyof ActionSurfaces)[];
  settingsState?: ActionSurfaceSettingsState;
  remedy?: string;
}>;

export type ResolveActionSurfaceAvailabilityArgs = Readonly<{
  actionId: ActionId | string;
  surface?: keyof ActionSurfaces | null;
  settings?: ActionsSettingsV1 | null;
  isActionEnabled?: ((id: ActionId) => boolean) | null;
  requireToolBinding?: boolean;
}>;

function getActionSpecOrNull(actionId: string): ActionSpec | null {
  try {
    return getActionSpec(actionId as ActionId);
  } catch {
    return null;
  }
}

function getAvailableSurfaces(
  spec: ActionSpec | null,
  requestedSurface: keyof ActionSurfaces | null,
): readonly (keyof ActionSurfaces)[] {
  if (!spec) return [];
  const candidateSurfaces = requestedSurface && ACTION_TOOL_EXPOSURE_SURFACE_SET.has(requestedSurface)
    ? ACTION_TOOL_EXPOSURE_SURFACES
    : ACTION_SURFACES;
  return candidateSurfaces.filter((surface) => spec.surfaces[surface] === true);
}

function resolveSettingsState(args: Readonly<{
  actionId: ActionId;
  surface: keyof ActionSurfaces | null;
  settings?: ActionsSettingsV1 | null;
}>): ActionSurfaceSettingsState {
  if (!args.settings) return 'unknown';
  if (!isActionEnabledByActionsSettings(args.actionId, args.settings, { surface: args.surface })) {
    return 'disabled';
  }
  if (isApprovalRequiredByActionsSettings(args.actionId, args.settings, { surface: args.surface })) {
    return 'approval_required';
  }
  return 'enabled';
}

function withRemedy(availability: Omit<ActionSurfaceAvailability, 'remedy'>): ActionSurfaceAvailability {
  if (availability.reason === 'unsupported_surface') {
    return {
      ...availability,
      remedy: 'Use a supported surface or expose this action on the requested surface.',
    };
  }
  if (availability.reason === 'missing_tool_binding') {
    return {
      ...availability,
      remedy: 'This action is discoverable but has no direct MCP tool binding.',
    };
  }
  if (availability.reason === 'disabled_by_settings') {
    return {
      ...availability,
      remedy: 'Enable this action for the requested surface in action settings.',
    };
  }
  if (availability.reason === 'disabled_by_policy') {
    return {
      ...availability,
      remedy: 'The caller policy disabled this action for the requested surface.',
    };
  }
  return availability;
}

export function resolveActionSurfaceAvailability(
  args: ResolveActionSurfaceAvailabilityArgs,
): ActionSurfaceAvailability {
  const actionId = String(args.actionId);
  const surface = args.surface ?? null;
  const spec = getActionSpecOrNull(actionId);
  const availableSurfaces = getAvailableSurfaces(spec, surface);

  if (!spec) {
    return withRemedy({
      available: false,
      reason: 'unknown_action',
      actionId,
      surface,
      availableSurfaces,
      settingsState: 'unknown',
    });
  }

  const typedActionId = spec.id as ActionId;
  const settingsState = resolveSettingsState({
    actionId: typedActionId,
    surface,
    settings: args.settings,
  });

  if (surface && spec.surfaces[surface] !== true) {
    return withRemedy({
      available: false,
      reason: 'unsupported_surface',
      actionId,
      surface,
      availableSurfaces,
      settingsState,
    });
  }

  if (settingsState === 'disabled') {
    return withRemedy({
      available: false,
      reason: 'disabled_by_settings',
      actionId,
      surface,
      availableSurfaces,
      settingsState,
    });
  }

  if (args.isActionEnabled && !args.isActionEnabled(typedActionId)) {
    return withRemedy({
      available: false,
      reason: 'disabled_by_policy',
      actionId,
      surface,
      availableSurfaces,
      settingsState,
    });
  }

  if (args.requireToolBinding === true && !spec.bindings?.mcpToolName) {
    return withRemedy({
      available: false,
      reason: 'missing_tool_binding',
      actionId,
      surface,
      availableSurfaces,
      settingsState,
    });
  }

  return {
    available: true,
    reason: 'available',
    actionId,
    surface,
    availableSurfaces,
    settingsState,
  };
}
