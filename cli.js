#!/usr/bin/env node
'use strict';

const path = require('path');

const { AgentState } = require('./state');
const { TranscriptWatcher } = require('./watcher');
const { DashboardServer } = require('./server');
const { resolveRenderedPokemonIdForAgent } = require('./pokemon');
const bootstrap = require('./bootstrap');
const configResolver = require('./configResolver');
const { createMockDriver: createSharedMockDriver } = require('./mockDriver');
const { applyClaudeEnvironment } = require('./claudeSettings');
const { normalizeCodexLine } = require('./codexParser');

const { DEFAULTS } = configResolver;

function normalizeMode(mode) {
  return mode === 'mock' ? 'mock' : 'watch';
}

function isSupportedMode(mode) {
  return mode === 'watch' || mode === 'mock';
}

function hasSource(source, target) {
  return source === 'all' || source === target;
}

function sourceList(source) {
  return source === 'all' ? ['claude', 'codex'] : [source || 'claude'];
}

function getPersistencePaths(mode, cwd = process.cwd(), source = 'claude') {
  const normalizedSource = configResolver.normalizeSource(source, DEFAULTS.source);
  const watchBaseDir = normalizedSource === 'claude'
    ? path.join(cwd, 'data')
    : path.join(cwd, 'data', 'runtime', normalizedSource);

  return bootstrap.resolvePersistPaths({
    mode,
    watchBaseDir,
    mockBaseDir: path.join(cwd, 'data', 'runtime', 'mock')
  });
}

function saveState(state, persist) {
  bootstrap.saveState(state, persist);
}

function loadState(state, persist) {
  return bootstrap.loadState(state, persist);
}

function savePokedex(state, persist) {
  bootstrap.savePokedex(state, persist);
}

function loadPokedex(state, persist) {
  return bootstrap.loadPokedex(state, persist);
}

function clearPersistedFiles(persist) {
  bootstrap.clearPersistedFiles(persist);
}

function readLiveSessionIds() {
  return bootstrap.readLiveSessionIds();
}

function performDashboardHardReset(options) {
  return bootstrap.performDashboardHardReset(options);
}

function resolveConfig(argv) {
  return configResolver.resolveCli(argv);
}

function usage() {
  return [
    'Usage:',
    '  node cli.js watch [--source claude|codex|all] [--port 8123] [--path ~/.claude/projects] [--codex-path ~/.codex/sessions] [--no-pokeapi]',
    '  node cli.js mock  [--port 8123] [--no-pokeapi]',
    '  node cli.js hard-reset [watch|mock] [--source claude|codex|all]',
    '',
    'Config precedence:',
    '  defaults < config.json < env vars < CLI flags',
    '',
    'Env vars:',
    '  PORT, HOST, AGENT_SAFARI_SOURCE, CLAUDE_PROJECTS_PATH, CODEX_SESSIONS_PATH, ACTIVE_TIMEOUT_SEC, STALE_TIMEOUT_SEC, ENABLE_POKEAPI_SPRITES'
  ].join('\n');
}

function createWatchers(config, state) {
  const watchers = [];
  if (hasSource(config.source, 'claude')) {
    watchers.push(new TranscriptWatcher({
      provider: 'claude',
      label: 'Claude Code',
      rootPath: config.claudeProjectsPath,
      staleTimeoutMs: config.staleTimeoutSec * 1000
    }));
  }
  if (hasSource(config.source, 'codex')) {
    watchers.push(new TranscriptWatcher({
      provider: 'codex',
      label: 'Codex',
      rootPath: config.codexSessionsPath,
      normalizeLine: normalizeCodexLine,
      staleTimeoutMs: config.staleTimeoutSec * 1000
    }));
  }

  for (const watcher of watchers) {
    watcher.on('info', (message) => process.stdout.write(`[watcher] ${message}\n`));
    watcher.on('warn', (message) => process.stderr.write(`[watcher] ${message}\n`));
    watcher.on('event', (event) => state.applyEvent(event));
  }

  return watchers;
}

function createMockDriver(state) {
  return createSharedMockDriver(state);
}

async function run() {
  const { command, config } = resolveConfig(process.argv.slice(2));

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'hard-reset') {
    const argv = process.argv.slice(2);
    const rawTargetMode = argv[1] || 'watch';
    if (!isSupportedMode(rawTargetMode)) {
      process.stderr.write(`Unknown hard-reset target: ${rawTargetMode}\n\n${usage()}\n`);
      process.exitCode = 1;
      return;
    }

    const targetMode = normalizeMode(rawTargetMode);
    const persist = getPersistencePaths(targetMode, process.cwd(), config.source);
    clearPersistedFiles(persist);
    bootstrap.markResetFlag(persist);
    process.stdout.write(`[hard-reset] cleared persisted ${targetMode}/${config.source} files in ${persist.baseDir}\n`);
    return;
  }

  if (!isSupportedMode(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const persist = getPersistencePaths(command, process.cwd(), command === 'watch' ? config.source : 'mock');
  const state = new AgentState({
    activeTimeoutSec: config.activeTimeoutSec,
    staleTimeoutSec: config.staleTimeoutSec,
    boxSubagentsImmediately: command !== 'mock',
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

  if (command === 'watch' && hasSource(config.source, 'claude')) {
    applyClaudeEnvironment();
  }

  loadState(state, persist);
  loadPokedex(state, persist);

  if (command === 'watch' && config.source === 'claude') {
    const startup = bootstrap.runStartupZombieBoxing(state);
    if (startup.boxedCount > 0) {
      process.stdout.write(`[startup] boxed ${startup.boxedCount} stale agent(s), ${state.agents.size} live agent(s) preserved\n`);
      saveState(state, persist);
    }
  }

  let watchers = [];
  let mock = null;

  const server = new DashboardServer({
    host: config.host,
    port: config.port,
    publicDir: path.join(process.cwd(), 'public'),
    state,
    publicConfig: {
      mode: command,
      source: command === 'watch' ? config.source : 'mock',
      enablePokeapiSprites: config.enablePokeapiSprites,
      isMockMode: command === 'mock',
      supportsHardReset: true
    },
    onHardReset: () => performDashboardHardReset({
      command,
      persist,
      state,
      mock,
      watcher: watchers.length > 0
        ? { resetToCurrentEnd: () => Promise.all(watchers.map((item) => item.resetToCurrentEnd())) }
        : null
    })
  });

  server.on('info', (message) => process.stdout.write(`[server] ${message}\n`));
  server.on('warn', (message) => process.stderr.write(`[server] ${message}\n`));
  state.on('pokedex', () => savePokedex(state, persist));
  savePokedex(state, persist);

  if (command === 'watch') {
    watchers = createWatchers(config, state);
  } else {
    mock = createMockDriver(state);
  }

  await server.start();

  process.stdout.write(`[config] mode=${command} source=${command === 'watch' ? config.source : 'mock'} port=${config.port}\n`);
  if (command === 'watch') {
    for (const source of sourceList(config.source)) {
      const watchedPath = source === 'codex' ? config.codexSessionsPath : config.claudeProjectsPath;
      process.stdout.write(`[config] ${source}Path=${watchedPath}\n`);
    }
  }
  process.stdout.write(`[persist] scope=${persist.scope} dir=${persist.baseDir}\n`);
  process.stdout.write(`[dashboard] http://${config.host}:${config.port}\n`);

  if (watchers.length > 0) {
    const skipInitialTail = bootstrap.consumeResetFlag(persist);
    if (skipInitialTail) {
      process.stdout.write('[persist] hard-reset flag detected - skipping initial transcript tail read\n');
    }
    for (const item of watchers) {
      await item.start({ skipInitialTail });
    }
  }

  if (mock) {
    mock.start();
    process.stdout.write('[mock] synthetic event generator started\n');
  }

  const tickTimer = bootstrap.startPeriodicTick(state);
  const pidCheckTimer = command === 'watch' && hasSource(config.source, 'claude') ? bootstrap.startPeriodicPidCheck(state) : null;
  const saveTimer = bootstrap.startPeriodicSave(state, persist);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    process.stdout.write(`\n[shutdown] received ${signal}, stopping...\n`);

    bootstrap.stopAll([tickTimer, pidCheckTimer, saveTimer]);
    saveState(state, persist);
    savePokedex(state, persist);
    process.stdout.write('[persist] state saved to disk\n');

    for (const item of watchers) {
      await item.stop();
    }

    if (mock) {
      mock.stop();
    }

    await server.stop();
    process.stdout.write('[shutdown] complete\n');
    process.exit(0);
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      process.stderr.write(`[shutdown] ${error.message}\n`);
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      process.stderr.write(`[shutdown] ${error.message}\n`);
      process.exit(1);
    });
  });
}

module.exports = {
  DEFAULTS,
  resolveConfig,
  createMockDriver,
  getPersistencePaths,
  saveState,
  loadState,
  savePokedex,
  loadPokedex,
  clearPersistedFiles,
  performDashboardHardReset,
  readLiveSessionIds,
  run
};

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
