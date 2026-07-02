import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { killProcessTree } from './utils/proc/proc.mjs';
import { spawnProc } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { killPortListeners } from './utils/net/ports.mjs';
import { getServerComponentName, isHappierServerRunning } from './utils/server/server.mjs';
import { requireDir } from './utils/proc/pm.mjs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkDaemonStatePingAware, getDaemonEnv, stopLocalDaemon } from './daemon.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { assertServerComponentDirMatches, assertServerPrismaProviderMatches } from './utils/server/validate.mjs';
import { getExpoStatePaths, isStateProcessRunning } from './utils/expo/expo.mjs';
import {
  createStackServerRuntimeProcessPatch,
  createStackDevProxyRuntimePatch,
  recordStackRuntimeStart,
  recordStackRuntimeUpdate,
} from './utils/stack/runtime_state.mjs';
import { startStackRuntimeDaemonPidReconciler } from './utils/stack/runtime_daemon_state.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import {
  createHappyCliReloadDescriptors,
  createHappyCliReloadExecutor,
  ensureDevCliReady,
  prepareDaemonAuthSeed,
  startDevDaemon,
} from './utils/dev/daemon.mjs';
import {
  createDevServerReloadDescriptors,
  createDevServerReloadExecutor,
  resolveStackOwnedServerRuntimePid,
  startDevServer,
} from './utils/dev/server.mjs';
import { resolveDevReloadPollIntervalMs, startDevReloadCoordinator } from './utils/dev/devReloadCoordinator.mjs';
import { prepareDevProxyStartup, resolveDevProxyStableHost, shouldEnableStackDevProxy } from './utils/dev/devProxy.mjs';
import { resolveDevServerConnection } from './utils/dev/resolveDevServerConnection.mjs';
import { isRuntimePortOwnedByStackDevProxy, resolveLocalServerPortForStack } from './utils/server/resolve_stack_server_port.mjs';
import { ensureDevExpoServer, resolveExpoTailscaleEnabled } from './utils/dev/expo_dev.mjs';
import { preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { waitForHttpOk } from './utils/server/server.mjs';
import { sanitizeDnsLabel } from './utils/net/dns.mjs';
import { getAccountCountForServerComponent, resolveAutoCopyFromMainEnabled } from './utils/stack/startup.mjs';
import { maybeRunInteractiveStackAuthSetup } from './utils/auth/interactive_stack_auth.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { daemonStartGate, formatDaemonAuthRequiredError } from './utils/auth/daemon_gate.mjs';
import { applyBindModeToEnv, resolveBindModeFromArgs } from './utils/net/bind_mode.mjs';
import { cmd, sectionTitle } from './utils/ui/layout.mjs';
import { renderTerminalUsageInstructions } from './utils/stack/terminal_usage_instructions.mjs';
import { resolveStackActiveServerId } from './utils/auth/stable_scope_id.mjs';
import { cyan, dim, green } from './utils/ui/ansi.mjs';
import { isSandboxed } from './utils/env/sandbox.mjs';
import { installExitCleanup } from './utils/proc/exit_cleanup.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { buildConfigureServerLinks } from '@happier-dev/cli-common/links';
import { spawnStackOwnerDeathWatchdog } from './utils/stack/owner_death_watchdog.mjs';
import { resolveTauriPaneInvocation } from './utils/tui/tauri_mode.mjs';
import { resolveReactNativeDevtoolsUrl } from './utils/dev/react_native_devtools.mjs';

 /**
  * Dev mode stack:
 * - happier-server-light
 * - happier-cli daemon
 * - Expo web dev server (watch/reload)
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (flags.has('--runtime') || flags.has('--source')) {
    throw new Error('[dev] hstack dev does not support runtime mode flags. Use hstack start for runtime snapshots.');
  }
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
	      data: {
		        flags: [
		          '--server=happier-server|happier-server-light',
		          '--server-flavor=light|full',
              '--server-url=http(s)://host[:port]',
              '--no-server',
		          '--no-ui',
		          '--no-daemon',
          '--restart',
          '--watch',
          '--no-watch',
          '--no-browser',
          '--no-proxy',
          '--mobile',
          '--rn-devtools',
          '--react-native-devtools',
          '--tauri',
          '--expo-tailscale',
          '--bind=loopback|lan',
          '--loopback',
          '--lan',
        ],
        json: true,
      },
		      text: [
		        '[dev] usage:',
		        '  hstack dev [--server=happier-server|happier-server-light] [--server-flavor=light|full] [--server-url=<http(s)://...>] [--no-server] [--restart] [--json]',
		        '  hstack dev --watch         # rebuild/restart happier-cli daemon on file changes (TTY default)',
	        '  hstack dev --no-watch      # disable watch mode (always disabled in non-interactive mode)',
	        '  hstack dev --no-browser    # do not open the UI in your browser automatically',
	        '  hstack dev --no-proxy      # bind the dev server directly instead of using the stable-port proxy',
	        '  hstack dev --mobile        # also start Expo dev-client Metro for mobile',
	        '  hstack dev --rn-devtools   # open React Native DevTools (Metro debugger UI) in your browser',
	        '  hstack dev --tauri         # start the desktop Tauri shell against this stack',
	        '  hstack dev --expo-tailscale # forward Expo to Tailscale interface for remote access',
	        '  hstack dev --bind=loopback  # prefer localhost-only URLs (not reachable from phones)',
	        '  hstack dev --no-server --server-url=https://api.example.com',
	        '  note: --json prints the resolved config (dry-run) and exits.',
        '',
        'note:',
        '  If run from inside a repo checkout/worktree, that checkout is used for this run (without requiring `hstack wt use`).',
        '',
        'env:',
        '  HAPPIER_STACK_EXPO_TAILSCALE=1   # enable Expo Tailscale forwarding via env var',
        '  HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB=8192  # default: 8192 (8GB) heap for the Expo/Metro Node process',
      ].join('\n'),
    });
    return;
  }
  const rootDir = getRootDir(import.meta.url);

  // Optional bind-mode override (affects Expo host/origins; best-effort sets HOST too).
  const bindMode = resolveBindModeFromArgs({ flags, kv });
  if (bindMode) {
    applyBindModeToEnv(process.env, bindMode);
  }

  // Outside sandbox mode we allow a convenience: if you run `hstack dev` from inside a repo checkout/worktree,
  // we use that checkout even if you never ran `hstack wt use`.
  //
  // In sandbox mode this would break isolation by pointing at your "real" checkout, so we disable it.
	  if (!isSandboxed()) {
	    const inferred = inferComponentFromCwd({
	      rootDir,
	      invokedCwd: getInvokedCwd(process.env),
	      components: ['happier-ui', 'happier-cli', 'happier-server-light', 'happier-server'],
	    });
    if (inferred) {
      // Stack env should win. Only infer from CWD when the repo dir isn't already configured.
      if (!(process.env.HAPPIER_STACK_REPO_DIR ?? '').toString().trim()) {
        process.env.HAPPIER_STACK_REPO_DIR = inferred.repoDir;
      }
    }
  }

  // Convenience alias: allow `--server-flavor=light|full` for parity with `stack pr` and `tools setup-pr`.
  // `--server=...` always wins when both are specified.
	  const serverFlavorFromArg = (kv.get('--server-flavor') ?? '').trim().toLowerCase();
	  if (!kv.get('--server') && serverFlavorFromArg) {
	    if (serverFlavorFromArg === 'light') kv.set('--server', 'happier-server-light');
	    else if (serverFlavorFromArg === 'full') kv.set('--server', 'happier-server');
	    else throw new Error(`[dev] invalid --server-flavor=${serverFlavorFromArg} (expected: light|full)`);
	  }

	  const serverComponentName = getServerComponentName({ kv });
	  if (serverComponentName === 'both') {
	    throw new Error(`[local] --server=both is not supported for dev (pick one: happier-server-light or happier-server)`);
	  }

  const startTauri = flags.has('--tauri') || flags.has('--with-tauri');
  const startUi = !flags.has('--no-ui');
  const startDaemon = !flags.has('--no-daemon');
  const openReactNativeDevtools = flags.has('--rn-devtools') || flags.has('--react-native-devtools');
  const noBrowser = startTauri || flags.has('--no-browser') || (process.env.HAPPIER_STACK_NO_BROWSER ?? '').toString().trim() === '1';
  const expoTailscale = flags.has('--expo-tailscale') || resolveExpoTailscaleEnabled({ env: process.env });
  const startMobile = flags.has('--mobile') || flags.has('--with-mobile') || expoTailscale;

  if (startTauri && !startUi) {
    throw new Error('[local] --tauri requires the ui');
  }

	  const serverDir = getComponentDir(rootDir, serverComponentName);
	  const uiDir = getComponentDir(rootDir, 'happier-ui');
	  const cliDir = getComponentDir(rootDir, 'happier-cli');

	  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const autostart = getDefaultAutostartPaths();
  const baseEnv = { ...process.env };
  const stackCtx = resolveStackContext({ env: baseEnv, autostart });
  const { stackMode, runtimeStatePath, stackName, envPath, ephemeral } = stackCtx;

  const serverPort = await resolveLocalServerPortForStack({
    env: baseEnv,
    stackMode,
    stackName,
    runtimeStatePath,
    defaultPort: 3005,
  });
  // IMPORTANT:
  // - Only the main stack should ever auto-enable (or prefer) Tailscale Serve by default.
  // - Non-main stacks should default to localhost URLs unless the user explicitly configured a public URL
  //   OR Tailscale Serve is already configured for this stack's internal URL (status matches).
  const allowEnableTailscale =
    !stackMode ||
    stackName === 'main' ||
    (baseEnv.HAPPIER_STACK_TAILSCALE_SERVE ?? '0').toString().trim() === '1';
  const resolvedUrls = await resolveServerUrls({ env: baseEnv, serverPort, allowEnable: allowEnableTailscale });
  const serverConnection = resolveDevServerConnection({
    flags,
    kv,
    env: baseEnv,
    resolvedLocalUrls: resolvedUrls,
  });
  const startServer = serverConnection.startServer;
  const localInternalServerUrl = resolvedUrls.internalServerUrl;
  const internalServerUrl = serverConnection.internalServerUrl;
  let publicServerUrl = serverConnection.publicServerUrl;
  if (startServer && stackMode && stackName !== 'main' && !resolvedUrls.envPublicUrl) {
    const src = String(resolvedUrls.publicServerUrlSource ?? '');
    const hasStackScopedTailscale = src.startsWith('tailscale-');
    if (!hasStackScopedTailscale) {
      publicServerUrl = resolvedUrls.defaultPublicUrl;
    }
  }
  // Expo app config: this is what both web + native app use to reach the Happy server.
  // LAN rewrite (for dev-client) is centralized in ensureDevExpoServer.
  const uiApiUrl = startServer ? resolvedUrls.defaultPublicUrl : serverConnection.uiApiUrl;
  const serverConnectionSource = serverConnection.source;
  const restart = flags.has('--restart');
  const cliHomeDir = process.env.HAPPIER_STACK_CLI_HOME_DIR?.trim()
    ? expandHome(process.env.HAPPIER_STACK_CLI_HOME_DIR.trim())
    : join(autostart.baseDir, 'cli');

  if (json) {
    printResult({
      json,
      data: {
        mode: 'dev',
        serverComponentName,
        serverDir,
        uiDir,
        cliDir,
        serverPort,
        internalServerUrl,
        publicServerUrl,
        startServer,
        serverConnectionSource,
        startUi,
        startMobile,
        startTauri,
        startDaemon,
        openReactNativeDevtools,
        cliHomeDir,
      },
    });
    return;
  }

  if (startServer) {
    assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });
    assertServerPrismaProviderMatches({ serverComponentName, serverDir });
    await requireDir(serverComponentName, serverDir);
  }
  await requireDir('happier-ui', uiDir);
  await requireDir('happier-cli', cliDir);

  const children = [];
  let shuttingDown = false;
  installExitCleanup({ label: 'local', children });

  // Ensure happier-cli is install+build ready before starting the daemon.
  // Worktrees often don't have dist/ built yet, which causes MODULE_NOT_FOUND on dist/index.mjs.
  const buildCli = (baseEnv.HAPPIER_STACK_CLI_BUILD ?? '1').toString().trim() !== '0';
  await ensureDevCliReady({ cliDir, buildCli });

  // Watch mode (interactive only by default): rebuild happier-cli and restart daemon when code changes.
  const watchEnabled =
    flags.has('--watch') || (!flags.has('--no-watch') && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const watchers = [];

  const serverAlreadyRunning = startServer
    ? await isHappierServerRunning(localInternalServerUrl)
    : false;
  const serverRuntimeProxyAlreadyOwned = startServer && stackMode && runtimeStatePath && !restart
    ? await isRuntimePortOwnedByStackDevProxy({
        env: baseEnv,
        port: serverPort,
        stackName,
        runtimeStatePath,
      })
    : false;
  const daemonAlreadyRunning = startDaemon
    ? ['running', 'starting'].includes((await checkDaemonStatePingAware(cliHomeDir, { serverUrl: internalServerUrl, env: baseEnv })).status)
    : false;

  // Expo dev server state (worktree-scoped): single Expo process per stack/worktree.
  const startExpo = startUi || startMobile;
  const expoPaths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'expo-dev',
    projectDir: uiDir,
    stateFileName: 'expo.state.json',
  });
  const expoRunning = startExpo ? await isStateProcessRunning(expoPaths.statePath) : { running: false, state: null };
  let expoAlreadyRunning = Boolean(expoRunning.running);

  if (!restart && (!startServer || serverAlreadyRunning) && (!startDaemon || daemonAlreadyRunning) && (!startExpo || expoAlreadyRunning)) {
    console.log(
      `${green('✓')} dev: already running ${dim('(')}` +
        `${dim('server=')}${cyan(internalServerUrl)}${startServer ? '' : dim(' (external)')}` +
        `${startDaemon ? ` ${dim('daemon=')}${daemonAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${startUi ? ` ${dim('ui=')}${expoAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${startMobile ? ` ${dim('mobile=')}${expoAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${dim(')')}`
    );
    return;
  }

  if (stackMode && runtimeStatePath) {
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
      script: 'dev.mjs',
      ephemeral,
      ownerPid: process.pid,
      ports: startServer ? { server: serverPort } : {},
    }).catch(() => {});
    spawnStackOwnerDeathWatchdog({
      rootDir,
      stackName,
      baseDir: autostart.baseDir,
      envPath,
      runtimeStatePath,
      ownerPid: process.pid,
      env: baseEnv,
    });
  }

  // Start server (only if not already healthy)
  // NOTE: In stack mode we avoid killing arbitrary port listeners (fail-closed instead).
  if (startServer && (!serverAlreadyRunning || restart) && !stackMode) {
    await killPortListeners(serverPort, { label: 'server' });
  }

  const devProxyEnabled = shouldEnableStackDevProxy({ startServer, flags, env: baseEnv });
  let proxyPlan = {
    mode: 'direct',
    stablePort: serverPort,
    backendPort: serverPort,
    proxyController: null,
    fallbackReason: null,
  };
  if (startServer && devProxyEnabled && (!serverAlreadyRunning || restart)) {
    const stableHost = resolveDevProxyStableHost({ env: baseEnv });
    proxyPlan = await prepareDevProxyStartup({
      enabled: true,
      stablePort: serverPort,
      stableHost,
      targetHost: '127.0.0.1',
      label: `${stackName ?? 'stack'}-server-proxy`,
      logger: console,
    });
  }
  const serverBindPort = proxyPlan.backendPort;
  const serverBackendInternalUrl = `http://127.0.0.1:${serverBindPort}`;

  const { serverEnv, serverScript, serverProc } = startServer
    ? await startDevServer({
        serverComponentName,
        serverDir,
        autostart,
        baseEnv,
        serverPort,
        serverBindPort,
        internalServerUrl: serverBackendInternalUrl,
        publicServerUrl,
        envPath,
        stackMode,
        runtimeStatePath,
        serverAlreadyRunning,
        restart,
        children,
        serverProxyRuntime: proxyPlan.mode === 'proxy'
          ? {
              enabled: true,
              proxyPid: proxyPlan.proxyController?.pid,
              mode: 'proxy',
              restartMode: 'exclusiveDb',
            }
          : null,
      })
    : { serverEnv: baseEnv, serverScript: null, serverProc: null };

  if (startServer && stackMode && runtimeStatePath && proxyPlan.mode === 'directFallback') {
    await recordStackRuntimeUpdate(
      runtimeStatePath,
      createStackDevProxyRuntimePatch({
        stablePort: serverPort,
        backendPort: null,
        proxyPid: null,
        backendPid: null,
        drainingPid: null,
        mode: 'directFallback',
        fallbackReason: proxyPlan.fallbackReason,
      }),
    ).catch(() => {});
  }

  if (!startServer) {
    console.log(`${green('✓')} server: external ${cyan(internalServerUrl)}`);
  } else if (!serverAlreadyRunning || restart) {
    console.log(`${green('✓')} server: ready at ${cyan(internalServerUrl)}`);
  } else {
    console.log(`${green('✓')} server: already running at ${cyan(internalServerUrl)}`);
  }
  console.log(
    renderTerminalUsageInstructions({
      internalServerUrl,
      cliHomeDir,
      publicServerUrl,
      activeServerId: resolveStackActiveServerId({ env: baseEnv, stackName }),
      stackName,
    }).join('\n'),
  );

  // Reliability before daemon start:
  // - Ensure schema exists (server-light: prisma migrate deploy; happier-server: migrate deploy if tables missing)
  // - Auto-seed from main only when needed (non-main + non-interactive default, and only if missing creds or 0 accounts)
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const accountProbe = startServer
    ? await getAccountCountForServerComponent({
        serverComponentName,
        serverDir,
        env: serverEnv,
        bestEffort: true,
      })
    : null;
  const accountCount =
    startServer && typeof accountProbe?.accountCount === 'number' ? accountProbe.accountCount : null;
  const autoSeedEnabled = resolveAutoCopyFromMainEnabled({ env: baseEnv, stackName, isInteractive });

  let expoResEarly = null;
  const wantsAuthFlow =
    (baseEnv.HAPPIER_STACK_AUTH_FLOW ?? '').toString().trim() === '1' ||
    (baseEnv.HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH ?? '').toString().trim() === '1';

  if (startServer) {
    // CRITICAL (review-pr / setup-pr guided login):
    // In background/non-interactive runs, the daemon may block on auth. If we wait to start Expo web
    // until after the daemon is authenticated, guided login will have no UI origin and will fall back
    // to the server port (wrong). Start Expo web UI early when running an auth flow.
    if (wantsAuthFlow && startUi && !expoResEarly) {
      expoResEarly = await ensureDevExpoServer({
        startUi,
        startMobile,
        uiDir,
        autostart,
        baseEnv,
        apiServerUrl: uiApiUrl,
        restart,
        stackMode,
        runtimeStatePath,
        stackName,
        envPath,
        children,
        spawnOptions: { stdio: ['ignore', 'ignore', 'ignore'] },
        expoTailscale,
      });
    }
    await maybeRunInteractiveStackAuthSetup({
      rootDir,
      // In dev mode, guided login must target the Expo web UI origin (not the server port).
      // Mark this as an auth-flow so URL resolution fails closed if Expo isn't ready.
      env: startUi ? { ...baseEnv, HAPPIER_STACK_AUTH_FLOW: '1' } : baseEnv,
      stackName,
      cliHomeDir,
      accountCount,
      isInteractive,
      autoSeedEnabled,
      beforeLogin: async () => {
        if (!startUi) {
          throw new Error(
            `[local] auth: interactive login requires the web UI.\n` +
              `Re-run without --no-ui, or set HAPPIER_WEBAPP_URL to a reachable Happier UI for this stack.`
          );
        }
        if (expoResEarly) return;
        expoResEarly = await ensureDevExpoServer({
          startUi,
          startMobile,
          uiDir,
          autostart,
          baseEnv,
          apiServerUrl: uiApiUrl,
          restart,
          stackMode,
          runtimeStatePath,
          stackName,
          envPath,
          children,
          expoTailscale,
        });
      },
    });
    await prepareDaemonAuthSeed({
      rootDir,
      env: baseEnv,
      stackName,
      cliHomeDir,
      startDaemon,
      isInteractive,
      serverComponentName,
      serverDir,
      serverEnv,
      quiet: false,
    });
  }

  if (startDaemon) {
    const gate = daemonStartGate({ env: baseEnv, cliHomeDir, serverUrl: internalServerUrl });
    if (!gate.ok) {
      // In orchestrated auth flows (setup-pr/review-pr), we intentionally keep server/UI up
      // for guided login and start daemon post-auth from the orchestrator.
      if (gate.reason === 'auth_flow_missing_credentials') {
        console.log('[local] auth flow: skipping daemon start until credentials exist');
      } else {
        const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!isInteractive) {
          throw new Error(formatDaemonAuthRequiredError({ stackName, cliHomeDir, serverUrl: internalServerUrl }));
        }
      }
    } else {
      await startDevDaemon({
        startDaemon,
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        runtimeStatePath,
        restart,
        isShuttingDown: () => shuttingDown,
        env: baseEnv,
        stackName,
      });
    }
  }

  if (startDaemon && stackMode && runtimeStatePath) {
    const daemonRuntimeEnv = getDaemonEnv({
      baseEnv,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl: publicServerUrl || internalServerUrl,
      stackName,
      cliIdentity: 'default',
    });
    const daemonRuntimeReconciler = startStackRuntimeDaemonPidReconciler(
      {
        runtimeStatePath,
        cliHomeDir,
        internalServerUrl,
        env: daemonRuntimeEnv,
        isShuttingDown: () => shuttingDown,
      },
      {
        checkDaemonStateImpl: checkDaemonStatePingAware,
      },
    );
    if (daemonRuntimeReconciler) {
      watchers.push(daemonRuntimeReconciler);
      await daemonRuntimeReconciler.syncNow();
    }
  }

  const serverProcRef = { current: serverProc };
  if (startServer && stackMode && runtimeStatePath && !serverProcRef.current?.pid && !serverRuntimeProxyAlreadyOwned) {
    // If the server was already running when we started dev, `startDevServer` won't spawn a new process
    // (and therefore we don't have a ChildProcess handle). For safe watch/restart we need a PID.
    const pid = await resolveStackOwnedServerRuntimePid({
      runtimeStatePath,
      serverPort: proxyPlan.mode === 'proxy' ? serverBindPort : serverPort,
      stackName,
      envPath,
    });
    if (Number.isFinite(pid) && pid > 1) {
      serverProcRef.current = { pid: Number(pid), exitCode: null };
      await recordStackRuntimeUpdate(
        runtimeStatePath,
        createStackServerRuntimeProcessPatch({
          listenerPid: Number(pid),
          wrapperPid: null,
          serverPort,
          clearProxyState: proxyPlan.mode !== 'proxy',
        }),
      ).catch(() => {});
    }
  }

  const reloadDescriptors = [];
  const reloadExecutors = [];
  const daemonReloadEnabled = watchEnabled && startDaemon && daemonStartGate({ env: baseEnv, cliHomeDir, serverUrl: internalServerUrl }).ok;
  const serverReloadEnabled = startServer && watchEnabled && Boolean(serverProcRef.current?.pid);

  if (daemonReloadEnabled) {
    reloadDescriptors.push(...createHappyCliReloadDescriptors({ cliDir }));
    reloadExecutors.push(createHappyCliReloadExecutor({
      startDaemon,
      buildCli,
      cliDir,
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => shuttingDown,
      env: baseEnv,
      stackName,
    }));
  }

  if (serverReloadEnabled) {
    reloadDescriptors.push(...createDevServerReloadDescriptors({ serverDir }));
    reloadExecutors.push(createDevServerReloadExecutor({
      enabled: true,
      stackMode,
      serverComponentName,
      serverDir,
      serverPort,
      serverBindPort,
      internalServerUrl,
      serverScript,
      serverEnv,
      runtimeStatePath,
      stackName,
      envPath,
      children,
      serverProcRef,
      isShuttingDown: () => shuttingDown,
      proxyController: proxyPlan.mode === 'proxy' ? proxyPlan.proxyController : null,
    }));
  }

  const reloadWatcher = startDevReloadCoordinator({
    enabled: watchEnabled,
    descriptors: reloadDescriptors,
    executors: reloadExecutors,
    debounceMs: 500,
    pollIntervalMs: resolveDevReloadPollIntervalMs(baseEnv),
    isShuttingDown: () => shuttingDown,
    logger: console,
  });
  if (reloadWatcher) watchers.push(reloadWatcher);

  if (startServer && watchEnabled && stackMode && serverComponentName === 'happier-server' && !serverReloadEnabled) {
    console.warn(
      `[local] watch: server restart is disabled because the running server PID is unknown.\n` +
        `[local] watch: fix: re-run with --restart so hstack can (re)spawn the server and track its PID.`
    );
  }

  const expoRes =
    expoResEarly ??
    (await ensureDevExpoServer({
      startUi,
      startMobile,
      uiDir,
      autostart,
      baseEnv,
      apiServerUrl: uiApiUrl,
      restart,
      stackMode,
      runtimeStatePath,
      stackName,
      envPath,
      children,
      expoTailscale,
    }));
  if (startUi) {
    const uiPort = expoRes?.port;
    const uiUrlRaw = uiPort ? `http://localhost:${uiPort}` : '';
    const uiUrl = uiUrlRaw ? await preferStackLocalhostUrl(uiUrlRaw, { stackName }) : '';
    const uiOpenUrl = uiUrl
      ? buildConfigureServerLinks({ webappUrl: uiUrl, serverUrl: publicServerUrl }).webUrl
      : '';
    if (expoRes?.reason === 'already_running' && expoRes.port) {
      console.log(`[local] ui already running (pid=${expoRes.pid}, port=${expoRes.port})`);
      if (uiOpenUrl) console.log(`[local] ui: open ${uiOpenUrl}`);
    } else if (expoRes?.skipped === false && expoRes.port) {
      if (uiOpenUrl) console.log(`[local] ui: open ${uiOpenUrl}`);
    } else if (expoRes?.skipped && expoRes?.reason === 'already_running') {
      console.log('[local] ui already running (skipping Expo start)');
    }

    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const shouldOpen = isInteractive && !noBrowser && Boolean(expoRes?.port);
    if (shouldOpen) {
      // Prefer localhost for readiness checks (faster/more reliable), but open the stack-scoped hostname.
      await waitForHttpOk(`http://localhost:${expoRes.port}`, { timeoutMs: 30_000 }).catch(() => {});
      const res = await openUrlInBrowser(uiOpenUrl || uiUrl);
      if (!res.ok) {
        console.warn(`[local] ui: failed to open browser automatically (${res.error}).`);
      }
    }
  }

  if (openReactNativeDevtools && expoRes?.port) {
    const metroOriginRaw = `http://localhost:${expoRes.port}`;
    const metroOrigin = await preferStackLocalhostUrl(metroOriginRaw, { stackName });
    const devtoolsUrl = resolveReactNativeDevtoolsUrl({ metroUrl: metroOrigin, env: baseEnv });
    if (devtoolsUrl) {
      console.log(`[local] rn-devtools: open ${devtoolsUrl}`);
      const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const shouldOpen = isInteractive && !noBrowser;
      if (shouldOpen) {
        await waitForHttpOk(devtoolsUrl, { timeoutMs: 30_000 }).catch(() => {});
        const res = await openUrlInBrowser(devtoolsUrl);
        if (!res.ok) {
          console.warn(`[local] rn-devtools: failed to open browser automatically (${res.error}).`);
        }
      }
    }
  }

  if (startMobile && expoRes?.port) {
    const metroUrl = await preferStackLocalhostUrl(`http://localhost:${expoRes.port}`, { stackName });
    console.log(`[local] mobile: metro ${metroUrl}`);
  }

  if (startTauri) {
    const invocation = resolveTauriPaneInvocation({ rootDir, env: baseEnv });
    const tauri = spawnProc('tauri', invocation.command, invocation.args, baseEnv, {
      cwd: invocation.cwd,
      ...(process.platform === 'win32'
        ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    });
    children.push(tauri);
  }

  // Show Tailscale URL if forwarder is running
  if (expoRes?.tailscale?.ok && expoRes.tailscale.tailscaleIp && expoRes.port) {
    console.log(`[local] expo tailscale: http://${expoRes.tailscale.tailscaleIp}:${expoRes.port}`);
  }

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\n[local] shutting down...');

    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }

    if (proxyPlan?.proxyController) {
      await proxyPlan.proxyController.stop().catch(() => {});
    }

    if (startDaemon) {
      await stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir, runtimeStatePath });
    }

    for (const child of children) {
      if (child.exitCode == null) {
        killProcessTree(child, 'SIGINT');
      }
    }

    await delay(1500);
    for (const child of children) {
      if (child.exitCode == null) {
        killProcessTree(child, 'SIGKILL');
      }
    }
  };

  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[local] failed:', err);
  process.exit(1);
});
