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

const { DEFAULTS } = configResolver;

function normalizeMode(mode) {
  return mode === 'mock' ? 'mock' : 'watch';
}

function isSupportedMode(mode) {
  return mode === 'watch' || mode === 'mock';
}

function getPersistencePaths(mode, cwd = process.cwd()) {
  return bootstrap.resolvePersistPaths({
    mode,
    watchBaseDir: path.join(cwd, 'data'),
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
    '  node cli.js watch [--port 8123] [--path ~/.claude/projects] [--no-pokeapi]',
    '  node cli.js mock  [--port 8123] [--no-pokeapi]',
    '  node cli.js hard-reset [watch|mock]',
    '',
    'Config precedence:',
    '  defaults < config.json < env vars < CLI flags',
    '',
    'Env vars:',
    '  PORT, HOST, CLAUDE_PROJECTS_PATH, ACTIVE_TIMEOUT_SEC, STALE_TIMEOUT_SEC, ENABLE_POKEAPI_SPRITES'
  ].join('\n');
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
    const persist = getPersistencePaths(targetMode);
    clearPersistedFiles(persist);
    bootstrap.markResetFlag(persist);
    process.stdout.write(`[hard-reset] cleared persisted ${targetMode} files in ${persist.baseDir}\n`);
    return;
  }

  if (!isSupportedMode(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const persist = getPersistencePaths(command);
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

  applyClaudeEnvironment();

  loadState(state, persist);
  loadPokedex(state, persist);

  if (command === 'watch') {
    const startup = bootstrap.runStartupZombieBoxing(state);
    if (startup.boxedCount > 0) {
      process.stdout.write(`[startup] boxed ${startup.boxedCount} stale agent(s), ${state.agents.size} live agent(s) preserved\n`);
      saveState(state, persist);
    }
  }

  let watcher = null;
  let mock = null;

  const server = new DashboardServer({
    host: config.host,
    port: config.port,
    publicDir: path.join(process.cwd(), 'public'),
    state,
    publicConfig: {
      mode: command,
      enablePokeapiSprites: config.enablePokeapiSprites,
      isMockMode: command === 'mock',
      supportsHardReset: true
    },
    onHardReset: () => performDashboardHardReset({ command, persist, state, mock, watcher })
  });

  server.on('info', (message) => process.stdout.write(`[server] ${message}\n`));
  server.on('warn', (message) => process.stderr.write(`[server] ${message}\n`));
  state.on('pokedex', () => savePokedex(state, persist));
  savePokedex(state, persist);

  if (command === 'watch') {
    watcher = new TranscriptWatcher({
      rootPath: config.claudeProjectsPath,
      staleTimeoutMs: config.staleTimeoutSec * 1000
    });

    watcher.on('info', (message) => process.stdout.write(`[watcher] ${message}\n`));
    watcher.on('warn', (message) => process.stderr.write(`[watcher] ${message}\n`));
    watcher.on('event', (event) => state.applyEvent(event));
  } else {
    mock = createMockDriver(state);
  }

  await server.start();

  process.stdout.write(`[config] mode=${command} port=${config.port} path=${config.claudeProjectsPath}\n`);
  process.stdout.write(`[persist] scope=${persist.scope} dir=${persist.baseDir}\n`);
  process.stdout.write(`[dashboard] http://${config.host}:${config.port}\n`);

  if (watcher) {
    const skipInitialTail = bootstrap.consumeResetFlag(persist);
    if (skipInitialTail) {
      process.stdout.write('[persist] hard-reset flag detected - skipping initial transcript tail read\n');
    }
    await watcher.start({ skipInitialTail });
  }

  if (mock) {
    mock.start();
    process.stdout.write('[mock] synthetic event generator started\n');
  }

  const tickTimer = bootstrap.startPeriodicTick(state);
  const pidCheckTimer = command === 'watch' ? bootstrap.startPeriodicPidCheck(state) : null;
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

    if (watcher) {
      await watcher.stop();
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
