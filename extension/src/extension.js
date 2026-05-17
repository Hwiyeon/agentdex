'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { AgentState } = require('../../state');
const { TranscriptWatcher } = require('../../watcher');
const { resolveRenderedPokemonIdForAgent } = require('../../pokemon');
const bootstrap = require('../../bootstrap');
const configResolver = require('../../configResolver');
const { createMockDriver } = require('../../mockDriver');
const { applyClaudeEnvironment } = require('../../claudeSettings');
const { normalizeCodexLine } = require('../../codexParser');
const { buildWebviewHtml } = require('./htmlTemplate');
const { createWebviewBridge } = require('./webviewBridge');
const { ensureSprites, readInstallState } = require('./assetManager');

const runtimes = new Map();

function hasSource(source, target) {
  return source === 'all' || source === target;
}

function runtimeKey(mode, source) {
  return mode === 'mock' ? 'mock' : `watch:${source || 'claude'}`;
}

function createAgentState(mode, config) {
  return new AgentState({
    activeTimeoutSec: config.activeTimeoutSec,
    staleTimeoutSec: config.staleTimeoutSec,
    boxSubagentsImmediately: mode !== 'mock',
    resolvePokemonId(agentId, context = {}) {
      const agent = context.agent || null;
      const meta = context.meta || {};
      return resolveRenderedPokemonIdForAgent(agentId, {
        parentId: (agent && agent.parentId) || meta.parentId || null,
        getAgentById: context.getAgentById,
        createdAt: (agent && agent.createdAt) || context.ts
      });
    }
  });
}

function extensionPersistPaths(globalStoragePath, mode, source = 'claude') {
  const normalizedSource = configResolver.normalizeSource(source, 'claude');
  const watchBaseDir = normalizedSource === 'claude'
    ? globalStoragePath
    : path.join(globalStoragePath, 'runtime', normalizedSource);

  return bootstrap.resolvePersistPaths({
    mode,
    watchBaseDir,
    mockBaseDir: path.join(globalStoragePath, 'runtime', 'mock')
  });
}

function getExtensionSettings() {
  const config = vscode.workspace.getConfiguration('pokeAgentSafari');
  return {
    config,
    assetMode: config.get('assetMode') === 'lite' ? 'lite' : 'full',
    useSprites: config.get('useSprites', true)
  };
}

function createWatchDrivers(source, runtimeConfig, state) {
  const drivers = [];
  if (hasSource(source, 'claude')) {
    drivers.push(new TranscriptWatcher({
      provider: 'claude',
      label: 'Claude Code',
      rootPath: runtimeConfig.claudeProjectsPath,
      staleTimeoutMs: runtimeConfig.staleTimeoutSec * 1000
    }));
  }
  if (hasSource(source, 'codex')) {
    drivers.push(new TranscriptWatcher({
      provider: 'codex',
      label: 'Codex',
      rootPath: runtimeConfig.codexSessionsPath,
      normalizeLine: normalizeCodexLine,
      staleTimeoutMs: runtimeConfig.staleTimeoutSec * 1000
    }));
  }

  for (const driver of drivers) {
    driver.on('info', (message) => console.log(`[watcher] ${message}`));
    driver.on('warn', (message) => console.warn(`[watcher] ${message}`));
    driver.on('event', (event) => state.applyEvent(event));
  }

  return drivers;
}

function createRuntimeWatcherFacade(drivers) {
  if (!drivers || drivers.length === 0) return null;
  if (drivers.length === 1) return drivers[0];
  return {
    on(eventName, listener) {
      for (const driver of drivers) {
        driver.on(eventName, listener);
      }
    },
    off(eventName, listener) {
      for (const driver of drivers) {
        driver.off(eventName, listener);
      }
    },
    resetToCurrentEnd() {
      return Promise.all(drivers.map((driver) => driver.resetToCurrentEnd()));
    }
  };
}

async function ensureRuntime(context, mode, source = 'claude') {
  const key = runtimeKey(mode, source);
  if (runtimes.has(key)) {
    return runtimes.get(key);
  }

  if (mode === 'watch' && hasSource(source, 'claude')) {
    applyClaudeEnvironment();
  }

  const settings = getExtensionSettings();
  const runtimeConfig = configResolver.resolveUnified({
    source: 'extension',
    vscodeConfig: settings.config,
    env: process.env,
    cli: { command: mode, args: { source } }
  });

  const globalStoragePath = context.globalStorageUri.fsPath;
  const persistPaths = extensionPersistPaths(globalStoragePath, mode, source);
  const state = createAgentState(mode, runtimeConfig);

  bootstrap.loadState(state, persistPaths);
  bootstrap.loadPokedex(state, persistPaths);
  bootstrap.savePokedex(state, persistPaths);

  if (mode === 'watch' && source === 'claude') {
    const startup = bootstrap.runStartupZombieBoxing(state);
    if (startup.boxedCount > 0) {
      bootstrap.saveState(state, persistPaths);
    }
  }

  const drivers = mode === 'watch' ? createWatchDrivers(source, runtimeConfig, state) : [];
  const driver = mode === 'watch' ? createRuntimeWatcherFacade(drivers) : createMockDriver(state);

  const publicConfig = {
    mode,
    source: mode === 'watch' ? source : 'mock',
    enablePokeapiSprites: !!(settings.useSprites && runtimeConfig.enablePokeapiSprites),
    isMockMode: mode === 'mock',
    supportsHardReset: true
  };

  const runtime = {
    mode,
    source,
    state,
    driver,
    drivers,
    runtimeConfig,
    persistPaths,
    publicConfig,
    panelCount: 0,
    active: false,
    timers: {},
    pokedexListener: () => bootstrap.savePokedex(state, persistPaths)
  };

  state.on('pokedex', runtime.pokedexListener);

  runtime.bridge = createWebviewBridge({
    state,
    publicConfig,
    watcher: mode === 'watch' ? driver : null,
    onWarning(message) {
      vscode.window.showWarningMessage(`Agent Safari: ${message}`);
    },
    onHardReset() {
      bootstrap.performDashboardHardReset({
        command: mode,
        persist: persistPaths,
        state,
        mock: mode === 'mock' ? driver : null,
        watcher: mode === 'watch' ? driver : null
      });
    }
  });

  runtimes.set(key, runtime);
  return runtime;
}

async function startRuntime(runtime) {
  if (runtime.active) return;

  runtime.timers.tick = bootstrap.startPeriodicTick(runtime.state);
  runtime.timers.save = bootstrap.startPeriodicSave(runtime.state, runtime.persistPaths);

  if (runtime.mode === 'watch') {
    const skipInitialTail = bootstrap.consumeResetFlag(runtime.persistPaths);
    for (const driver of runtime.drivers) {
      await driver.start({ skipInitialTail });
    }
    if (hasSource(runtime.source, 'claude')) {
      runtime.timers.pidCheck = bootstrap.startPeriodicPidCheck(runtime.state);
    }
  } else {
    runtime.driver.start();
  }

  runtime.active = true;
}

async function stopRuntime(runtime) {
  if (!runtime || !runtime.active) return;

  bootstrap.stopAll(runtime.timers);
  runtime.timers = {};

  bootstrap.saveState(runtime.state, runtime.persistPaths);
  bootstrap.savePokedex(runtime.state, runtime.persistPaths);

  if (runtime.mode === 'watch') {
    for (const driver of runtime.drivers) {
      await driver.stop();
    }
  } else {
    runtime.driver.stop();
  }

  runtime.active = false;
}

async function ensureAssets(context) {
  const settings = getExtensionSettings();
  if (!settings.useSprites) {
    return {
      assetRoot: path.join(context.globalStorageUri.fsPath, 'pokeapi-sprites'),
      enabled: false
    };
  }

  const assetRoot = path.join(context.globalStorageUri.fsPath, 'pokeapi-sprites');
  const installState = readInstallState(assetRoot);
  if (installState && (installState.mode === settings.assetMode || installState.mode === 'full')) {
    return { assetRoot, enabled: true };
  }

  const choice = await vscode.window.showInformationMessage(
    'Agent Safari needs sprite assets before the VS Code panel can open.',
    { modal: true },
    'Download full sprites',
    'Download lite sprites',
    'Cancel'
  );

  if (!choice || choice === 'Cancel') {
    return { assetRoot, enabled: false, cancelled: true };
  }

  const mode = choice.includes('lite') ? 'lite' : 'full';
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Agent Safari: downloading ${mode} sprites`,
    cancellable: false
  }, async (progress) => {
    await ensureSprites(assetRoot, mode, {
      progress(update) {
        progress.report({
          message: `${update.completed}/${update.total} ${update.label}`,
          increment: update.total ? (100 / update.total) : 0
        });
      }
    });
  });

  return { assetRoot, enabled: true };
}

function buildPanelHtml(context, panel, assetRoot) {
  const publicDir = vscode.Uri.joinPath(context.extensionUri, 'public');
  const dataDir = vscode.Uri.joinPath(context.extensionUri, 'data');
  const htmlPath = vscode.Uri.joinPath(publicDir, 'index.html').fsPath;
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(publicDir, 'style.css')).toString();
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(publicDir, 'app.js')).toString();
  const assetBase = panel.webview.asWebviewUri(vscode.Uri.file(assetRoot)).toString();
  const dataBase = panel.webview.asWebviewUri(dataDir).toString();

  return buildWebviewHtml({
    htmlRaw: fs.readFileSync(htmlPath, 'utf8'),
    cssUri: styleUri,
    jsUri: scriptUri,
    assetBase,
    dataBase,
    cspSource: panel.webview.cspSource
  });
}

async function openPanel(context, mode, source = 'claude') {
  const assetState = await ensureAssets(context);
  if (assetState.cancelled) {
    return;
  }

  const runtime = await ensureRuntime(context, mode, source);
  runtime.publicConfig.enablePokeapiSprites = !!assetState.enabled && runtime.runtimeConfig.enablePokeapiSprites;

  if (runtime.panelCount === 0) {
    await startRuntime(runtime);
  }

  const sourceTitle = source === 'codex' ? ' (Codex)' : source === 'all' ? ' (All)' : '';
  const title = mode === 'mock' ? 'Agent Safari (Mock)' : `Agent Safari${sourceTitle}`;
  const panel = vscode.window.createWebviewPanel(
    'pokeAgentSafari',
    title,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        context.extensionUri,
        vscode.Uri.file(assetState.assetRoot)
      ]
    }
  );

  panel.webview.html = buildPanelHtml(context, panel, assetState.assetRoot);
  const bridgeAttachment = runtime.bridge.attach(panel);
  runtime.panelCount += 1;

  panel.onDidDispose(async () => {
    bridgeAttachment.dispose();
    runtime.panelCount = Math.max(0, runtime.panelCount - 1);
    if (runtime.panelCount === 0) {
      await stopRuntime(runtime);
    }
  });
}

async function runHardResetCommand(context) {
  const runtime = Array.from(runtimes.values()).find((item) => item.panelCount > 0) || runtimes.get(runtimeKey('watch', 'claude'));
  const mode = runtime ? runtime.mode : 'watch';
  const source = runtime ? runtime.source : 'claude';
  if (runtime) {
    bootstrap.performDashboardHardReset({
      command: mode,
      persist: runtime.persistPaths,
      state: runtime.state,
      mock: mode === 'mock' ? runtime.driver : null,
      watcher: mode === 'watch' ? runtime.driver : null
    });
    return;
  }

  const persistPaths = extensionPersistPaths(context.globalStorageUri.fsPath, mode, source);
  bootstrap.clearPersistedFiles(persistPaths);
  if (mode === 'watch') {
    bootstrap.markResetFlag(persistPaths);
  }
  vscode.window.showInformationMessage(`Agent Safari ${mode}/${source} data reset.`);
}

async function runAssetDownload(context) {
  await ensureAssets(context);
}

async function activate(context) {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  context.subscriptions.push(
    vscode.commands.registerCommand('pokeAgentSafari.open', () => openPanel(context, 'watch', 'claude')),
    vscode.commands.registerCommand('pokeAgentSafari.openCodex', () => openPanel(context, 'watch', 'codex')),
    vscode.commands.registerCommand('pokeAgentSafari.openAll', () => openPanel(context, 'watch', 'all')),
    vscode.commands.registerCommand('pokeAgentSafari.openMock', () => openPanel(context, 'mock', 'mock')),
    vscode.commands.registerCommand('pokeAgentSafari.hardReset', () => runHardResetCommand(context)),
    vscode.commands.registerCommand('pokeAgentSafari.downloadAssets', () => runAssetDownload(context))
  );
}

async function deactivate() {
  for (const runtime of runtimes.values()) {
    await stopRuntime(runtime);
    runtime.bridge.dispose();
    runtime.state.off('pokedex', runtime.pokedexListener);
  }
  runtimes.clear();
}

module.exports = {
  activate,
  deactivate
};
