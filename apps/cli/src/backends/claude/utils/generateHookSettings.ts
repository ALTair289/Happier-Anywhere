/**
 * Generate temporary hook artifacts for a Claude CLI session.
 *
 * Hooks are registered via `--plugin-dir <dir>` (an ephemeral session-only plugin
 * whose only payload is a `hooks/hooks.json`). Non-hook configuration (for now just
 * the `mcp__happier__change_title*` allow rules) still rides on `--settings <file>`.
 *
 * Why not put the hooks in the `--settings` overlay like we used to?
 *
 * Claude Code's CLI treats `--settings` as a single overlay: when two `--settings`
 * flags are passed, only the first wins and subsequent ones are silently dropped
 * for hooks. Any PATH-resident wrapper that prepends its own `--settings` (cmux's
 * `/Applications/cmux.app/.../bin/claude` is the case we hit) causes Happier's
 * hooks to be silently discarded — no SessionStart fires, no transcript sync,
 * empty mobile UI.
 *
 * `--plugin-dir` is in a different, additive channel: multiple plugin dirs compose
 * without collision, and our hooks fire regardless of what else is in the spawn
 * chain. This module produces both artifacts so the caller can pass
 *   claude --plugin-dir <pluginDir> --settings <settingsFile> ...
 * and have hooks register reliably.
 *
 * Set `HAPPIER_CLAUDE_HOOKS_DISABLED=1` in the environment to suppress plugin-dir
 * generation entirely (for debugging Happier-spawned Claude without hook mirroring).
 * The non-hook settings file is still written in that mode.
 */

import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { buildMissingJavaScriptRuntimeMessage } from '@/runtime/js/buildMissingJavaScriptRuntimeMessage';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import { resolveClaudePermissionHookTimeoutSeconds } from './permissionHookTimeout';

export { DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS } from './permissionHookTimeout';

export interface GenerateHookSettingsOptions {
    enableLocalPermissionBridge?: boolean;
    permissionHookSecret?: string;
    /**
     * Explicit Claude command-hook `timeout` (seconds) installed on the PermissionRequest /
     * PreToolUse(AskUserQuestion) permission hooks.
     *
     * This makes the provider-side hook ceiling explicit instead of silently relying on Claude's
     * undocumented default. The shared timeout resolver is also used by the local permission bridge's
     * expiry boundary so a late UI answer after the ceiling returns a typed expired result instead of a
     * false success.
     */
    permissionHookTimeoutSeconds?: number;
}

type ClaudeSettingsOverlay = Readonly<{
    permissions?: Readonly<{
        allow?: readonly string[];
    }>;
}>;

const HOOKS_DISABLED_ENV_VAR = 'HAPPIER_CLAUDE_HOOKS_DISABLED';

function areHappierHooksDisabled(): boolean {
    const raw = process.env[HOOKS_DISABLED_ENV_VAR];
    if (typeof raw !== 'string') return false;
    const trimmed = raw.trim().toLowerCase();
    return trimmed === '1' || trimmed === 'true' || trimmed === 'yes';
}

function resolveNodeExecutable(): string {
    const nodeExecutable = resolveJavaScriptRuntimeExecutable({ isBunRuntime: isBun() });
    if (!nodeExecutable) {
        throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('claude session hook plugin'));
    }
    return nodeExecutable;
}

function resolveTmpRoot(subdirName: 'hooks' | 'hook-plugins'): string {
    const root = join(
        configuration.happyHomeDir,
        'tmp',
        resolveReleaseRingScopedBasename(subdirName, configuration.publicReleaseRing),
    );
    mkdirPrivateSync(root);
    return root;
}

function chmodIfSupported(path: string, mode: number): void {
    if (process.platform === 'win32') return;
    try {
        chmodSync(path, mode);
    } catch {
        // Best-effort hardening; write/mkdir mode still applies on creation.
    }
}

function mkdirPrivateSync(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodIfSupported(path, 0o700);
}

function writePrivateFileSync(path: string, contents: string): void {
    writeFileSync(path, contents, { mode: 0o600 });
    chmodIfSupported(path, 0o600);
}

/**
 * Generate a temporary settings JSON file with non-hook configuration only
 * (currently: MCP change_title allow rules). Hooks are no longer carried here;
 * see `generateHookPluginDir` for those.
 */
export function generateHookSettingsFile(_port: number, _options: GenerateHookSettingsOptions = {}): string {
    const hooksDir = resolveTmpRoot('hooks');

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    const settings: ClaudeSettingsOverlay = {
        permissions: {
            allow: [
                'mcp__happier__change_title',
                'mcp__happier__session_title_set',
            ],
        },
    };

    writePrivateFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created settings file: ${filepath}`);

    return filepath;
}

/**
 * Generate a temporary plugin directory containing `hooks/hooks.json`.
 * Claude is launched with `--plugin-dir <returned path>` so the session registers
 * these hooks as an additive, session-only plugin.
 *
 * Returns `null` when `HAPPIER_CLAUDE_HOOKS_DISABLED=1` is set — callers should
 * then skip passing `--plugin-dir` and proceed without hook mirroring.
 */
export function generateHookPluginDir(port: number, options: GenerateHookSettingsOptions = {}): string | null {
    if (areHappierHooksDisabled()) {
        logger.debug(`[generateHookSettings] ${HOOKS_DISABLED_ENV_VAR} is set; skipping hook plugin generation`);
        return null;
    }

    const pluginsRoot = resolveTmpRoot('hook-plugins');
    const pluginDir = join(pluginsRoot, `session-${process.pid}`);
    const manifestDir = join(pluginDir, '.claude-plugin');
    const hooksDir = join(pluginDir, 'hooks');
    // hooks.json points at the private permission secret file; keep the whole session plugin dir
    // owner-only so other local users cannot read paths/settings or race the secret file.
    mkdirPrivateSync(pluginDir);
    mkdirPrivateSync(manifestDir);
    mkdirPrivateSync(hooksDir);

    const manifest = {
        name: `happier-session-hooks-${process.pid}`,
        version: '1.0.0',
        description: 'Happier session-scoped Claude Code hooks.',
        author: {
            name: 'Happier',
        },
    };
    writePrivateFileSync(join(manifestDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    const nodeExecutable = resolveNodeExecutable();
    // The secret never rides on the command line (argv is world-visible via `ps`); it is written
    // to an owner-only file inside the 0700 plugin dir and forwarders read it via
    // `--secret-file <path>`. Shared by the session AND permission forwarders (A5-MED-2: the
    // session-start endpoint requires the same secret as the permission endpoint).
    let secretPart = '';
    if (typeof options.permissionHookSecret === 'string' && options.permissionHookSecret.length > 0) {
        const secretFile = join(pluginDir, 'permission-hook-secret');
        writePrivateFileSync(secretFile, options.permissionHookSecret);
        secretPart = ` --secret-file ${JSON.stringify(secretFile)}`;
    }
    const sessionForwarderScript = resolveCliRuntimeAssetPath('scripts', 'session_hook_forwarder.cjs');
    const buildSessionHookCommand = (hookEventName: string): string =>
        `${JSON.stringify(nodeExecutable)} ${JSON.stringify(sessionForwarderScript)} ${port} ${JSON.stringify(hookEventName)}${secretPart}`;

    const buildSessionHook = (hookEventName: string): unknown[] => [
        {
            matcher: '',
            hooks: [
                {
                    type: 'command',
                    command: buildSessionHookCommand(hookEventName),
                },
            ],
        },
    ];

    const hooks: Record<string, unknown> = {
        SessionStart: buildSessionHook('SessionStart'),
        UserPromptSubmit: buildSessionHook('UserPromptSubmit'),
        Stop: buildSessionHook('Stop'),
        StopFailure: buildSessionHook('StopFailure'),
        SessionEnd: buildSessionHook('SessionEnd'),
        PostToolUse: buildSessionHook('PostToolUse'),
    };

    if (options.enableLocalPermissionBridge) {
        const permissionForwarderScript = resolveCliRuntimeAssetPath('scripts', 'permission_hook_forwarder.cjs');
        const buildPermissionCommand = (hookEventName: 'PermissionRequest' | 'PreToolUse'): string =>
            `${JSON.stringify(nodeExecutable)} ${JSON.stringify(permissionForwarderScript)} ${port} ${JSON.stringify(hookEventName)}${secretPart}`;

        const permissionHookTimeoutSeconds = resolveClaudePermissionHookTimeoutSeconds(options);

        hooks.PermissionRequest = [
            {
                matcher: '',
                hooks: [
                    {
                        type: 'command',
                        command: buildPermissionCommand('PermissionRequest'),
                        timeout: permissionHookTimeoutSeconds,
                    },
                ],
            },
        ];
        hooks.PreToolUse = [
            {
                matcher: 'AskUserQuestion',
                hooks: [
                    {
                        type: 'command',
                        command: buildPermissionCommand('PreToolUse'),
                        timeout: permissionHookTimeoutSeconds,
                    },
                ],
            },
        ];
    }

    const hooksJson = { hooks };
    const hooksFile = join(hooksDir, 'hooks.json');
    writePrivateFileSync(hooksFile, JSON.stringify(hooksJson, null, 2));
    logger.debug(`[generateHookSettings] Created hook plugin dir: ${pluginDir}`);

    return pluginDir;
}

/**
 * Remove the settings file produced by `generateHookSettingsFile`.
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up settings file: ${filepath}`);
        }
        // The unified spawn writes merged --settings overlays (which may embed the hook secret)
        // to a 0600 sibling of this file; it rides the same cleanup lifecycle.
        const overlayPath = filepath.replace(/\.json$/, '.overlay.json');
        if (overlayPath !== filepath && existsSync(overlayPath)) {
            unlinkSync(overlayPath);
            logger.debug(`[generateHookSettings] Cleaned up settings overlay file: ${overlayPath}`);
        }
        const statuslineSecretPath = filepath.replace(/\.json$/, '.statusline-secret');
        if (statuslineSecretPath !== filepath && existsSync(statuslineSecretPath)) {
            unlinkSync(statuslineSecretPath);
            logger.debug(`[generateHookSettings] Cleaned up statusline secret file: ${statuslineSecretPath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup settings file: ${error}`);
    }
}

/**
 * Remove the plugin directory produced by `generateHookPluginDir`.
 */
export function cleanupHookPluginDir(dirpath: string | null | undefined): void {
    if (typeof dirpath !== 'string' || dirpath.length === 0) return;
    try {
        if (existsSync(dirpath)) {
            rmSync(dirpath, { recursive: true, force: true });
            logger.debug(`[generateHookSettings] Cleaned up hook plugin dir: ${dirpath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook plugin dir: ${error}`);
    }
}
