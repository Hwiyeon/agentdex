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
const { buildWebviewHtml } = require('./htmlTemplate');
const { createWebviewBridge } = require('./webviewBridge');
const { ensureSprites, readInstallState } = require('./assetManager');

const runtimes = new Map();

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

function extensionPersistPaths(globalStoragePath, mode) {
  return bootstrap.resolvePersistPaths({
    mode,
    watchBaseDir: globalStoragePath,
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

async function ensureRuntime(context, mode) {
  if (runtimes.has(mode)) {
    return runtimes.get(mode);
  }

  applyClaudeEnvironment();

  const settings = getExtensionSettings();
  const runtimeConfig = configResolver.resolveUnified({
    source: 'extension',
    vscodeConfig: settings.config,
    env: process.env,
    cli: { command: mode, args: {} }
  });

  const globalStoragePath = context.globalStorageUri.fsPath;
  const persistPaths = extensionPersistPaths(globalStoragePath, mode);
  const state = createAgentState(mode, runtimeConfig);

  bootstrap.loadState(state, persistPaths);
  bootstrap.loadPokedex(state, persistPaths);
  bootstrap.savePokedex(state, persistPaths);

  if (mode === 'watch') {
    const startup = bootstrap.runStartupZombieBoxing(state);
    if (startup.boxedCount > 0) {
      bootstrap.saveState(state, persistPaths);
    }
  }

  const driver = mode === 'watch'
    ? new TranscriptWatcher({
      rootPath: runtimeConfig.claudeProjectsPath,
      staleTimeoutMs: runtimeConfig.staleTimeoutSec * 1000
    })
    : createMockDriver(state);

  if (mode === 'watch') {
    driver.on('info', (message) => console.log(`[watcher] ${message}`));
    driver.on('warn', (message) => console.warn(`[watcher] ${message}`));
    driver.on('event', (event) => state.applyEvent(event));
  }

  const publicConfig = {
    mode,
    enablePokeapiSprites: !!(settings.useSprites && runtimeConfig.enablePokeapiSprites),
    isMockMode: mode === 'mock',
    supportsHardReset: true
  };

  const runtime = {
    mode,
    state,
    driver,
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

  runtimes.set(mode, runtime);
  return runtime;
}

async function startRuntime(runtime) {
  if (runtime.active) return;

  runtime.timers.tick = bootstrap.startPeriodicTick(runtime.state);
  runtime.timers.save = bootstrap.startPeriodicSave(runtime.state, runtime.persistPaths);

  if (runtime.mode === 'watch') {
    const skipInitialTail = bootstrap.consumeResetFlag(runtime.persistPaths);
    await runtime.driver.start({ skipInitialTail });
    runtime.timers.pidCheck = bootstrap.startPeriodicPidCheck(runtime.state);
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
    await runtime.driver.stop();
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

async function openPanel(context, mode) {
  const assetState = await ensureAssets(context);
  if (assetState.cancelled) {
    return;
  }

  const runtime = await ensureRuntime(context, mode);
  runtime.publicConfig.enablePokeapiSprites = !!assetState.enabled && runtime.runtimeConfig.enablePokeapiSprites;

  if (runtime.panelCount === 0) {
    await startRuntime(runtime);
  }

  const title = mode === 'mock' ? 'Agent Safari (Mock)' : 'Agent Safari';
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
  const mode = (runtimes.get('mock') && runtimes.get('mock').panelCount > 0) ? 'mock' : 'watch';
  const runtime = runtimes.get(mode);
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

  const persistPaths = extensionPersistPaths(context.globalStorageUri.fsPath, mode);
  bootstrap.clearPersistedFiles(persistPaths);
  if (mode === 'watch') {
    bootstrap.markResetFlag(persistPaths);
  }
  vscode.window.showInformationMessage(`Agent Safari ${mode} data reset.`);
}

async function runAssetDownload(context) {
  await ensureAssets(context);
}

async function activate(context) {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  context.subscriptions.push(
    vscode.commands.registerCommand('pokeAgentSafari.open', () => openPanel(context, 'watch')),
    vscode.commands.registerCommand('pokeAgentSafari.openMock', () => openPanel(context, 'mock')),
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
