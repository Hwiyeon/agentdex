'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { POKEDEX_MAX } = require('./pokemon');

function normalizeMode(mode) {
  return mode === 'mock' ? 'mock' : 'watch';
}

function resolvePersistPaths(options = {}) {
  const scope = normalizeMode(options.mode);
  const watchBaseDir = path.resolve(options.watchBaseDir || path.join(process.cwd(), 'data'));
  const mockBaseDir = path.resolve(options.mockBaseDir || path.join(process.cwd(), 'data', 'runtime', 'mock'));
  const baseDir = scope === 'mock' ? mockBaseDir : watchBaseDir;

  return {
    scope,
    baseDir,
    stateFile: path.join(baseDir, 'state.json'),
    pokedexFile: path.join(baseDir, 'pokedex.json'),
    resetFlagFile: path.join(baseDir, '.hard-reset')
  };
}

function ensurePersistenceDir(persist) {
  fs.mkdirSync(persist.baseDir, { recursive: true });
}

function saveState(state, persist) {
  try {
    ensurePersistenceDir(persist);
    const data = state.serialize();
    fs.writeFileSync(persist.stateFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    process.stderr.write(`[persist] save failed: ${error.message}\n`);
  }
}

function loadState(state, persist) {
  try {
    if (!fs.existsSync(persist.stateFile)) return false;
    const raw = fs.readFileSync(persist.stateFile, 'utf8');
    const data = JSON.parse(raw);
    const ok = state.restore(data);
    if (ok) {
      process.stdout.write(`[persist] restored ${data.agents ? data.agents.length : 0} agents, ${data.boxedAgents ? data.boxedAgents.length : 0} boxed\n`);
    }
    return ok;
  } catch (error) {
    process.stderr.write(`[persist] load failed: ${error.message}\n`);
    return false;
  }
}

function savePokedex(state, persist) {
  try {
    ensurePersistenceDir(persist);
    const pokedex = state.pokedexSnapshot();
    const data = {
      version: 1,
      updatedAt: Date.now(),
      seenPokemonIds: pokedex.seenPokemonIds,
      firstDiscoveryByPokemon: pokedex.firstDiscoveryByPokemon,
      discovered: pokedex.discoveredCount,
      total: POKEDEX_MAX
    };
    fs.writeFileSync(persist.pokedexFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    process.stderr.write(`[pokedex] save failed: ${error.message}\n`);
  }
}

function loadPokedex(state, persist) {
  try {
    if (!fs.existsSync(persist.pokedexFile)) return false;
    const raw = fs.readFileSync(persist.pokedexFile, 'utf8');
    const data = JSON.parse(raw);
    state.mergeSeenPokemonIds(data.seenPokemonIds, data.firstDiscoveryByPokemon);
    process.stdout.write(`[pokedex] restored ${Array.isArray(data.seenPokemonIds) ? data.seenPokemonIds.length : 0} discovered pokemon\n`);
    return true;
  } catch (error) {
    process.stderr.write(`[pokedex] load failed: ${error.message}\n`);
    return false;
  }
}

function clearPersistedFiles(persist) {
  for (const filePath of [persist.stateFile, persist.pokedexFile]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      process.stderr.write(`[persist] reset cleanup failed for ${path.basename(filePath)}: ${error.message}\n`);
    }
  }
}

function readLiveSessionIds(sessionsDir = path.join(os.homedir(), '.claude', 'sessions')) {
  const liveSessionIds = new Set();
  let files;
  try {
    files = fs.readdirSync(sessionsDir).filter((fileName) => fileName.endsWith('.json'));
  } catch (_) {
    return liveSessionIds;
  }

  for (const fileName of files) {
    try {
      const raw = fs.readFileSync(path.join(sessionsDir, fileName), 'utf8');
      const data = JSON.parse(raw);
      if (!data.sessionId || !data.pid) continue;

      try {
        process.kill(data.pid, 0);
        liveSessionIds.add(data.sessionId);
      } catch (_) {
        // Ignore dead processes.
      }
    } catch (_) {
      // Ignore malformed session files.
    }
  }

  return liveSessionIds;
}

function runStartupZombieBoxing(state, sessionsDir = path.join(os.homedir(), '.claude', 'sessions')) {
  const liveSessionIds = readLiveSessionIds(sessionsDir);
  let boxedCount = 0;

  for (const [agentId, agent] of [...state.agents.entries()]) {
    if (agent.parentId) continue;
    if (liveSessionIds.has(agent.sessionId)) continue;
    state.boxAgent(agent);
    state.removeAgent(agentId);
    boxedCount += 1;
  }

  for (const [, agent] of state.agents.entries()) {
    if (!agent.parentId && liveSessionIds.has(agent.sessionId)) continue;
    if (agent.sessionId && agent.sessionId !== 'unknown-session') {
      state.suppressedSessions.add(agent.sessionId);
    }
  }

  for (const entry of state.boxedAgents) {
    if (entry.sessionId && entry.sessionId !== 'unknown-session') {
      state.suppressedSessions.add(entry.sessionId);
    }
  }

  return {
    boxedCount,
    liveSessionIds
  };
}

function createSessionPidMap(sessionsDir = path.join(os.homedir(), '.claude', 'sessions')) {
  let files;
  try {
    files = fs.readdirSync(sessionsDir).filter((fileName) => fileName.endsWith('.json'));
  } catch (_) {
    return null;
  }

  const sessionPidMap = new Map();
  for (const fileName of files) {
    try {
      const raw = fs.readFileSync(path.join(sessionsDir, fileName), 'utf8');
      const data = JSON.parse(raw);
      if (data.sessionId && data.pid) {
        sessionPidMap.set(data.sessionId, data.pid);
      }
    } catch (_) {
      // Ignore malformed session files.
    }
  }

  return sessionPidMap;
}

function runSessionPidCheck(state, sessionsDir = path.join(os.homedir(), '.claude', 'sessions')) {
  const sessionPidMap = createSessionPidMap(sessionsDir);
  if (!sessionPidMap) {
    state.checkSessionPids(new Map(), true);
    return;
  }
  state.checkSessionPids(sessionPidMap, true);
}

function startPeriodicTick(state, options = {}) {
  const intervalMs = options.intervalMs || 1000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timer = setInterval(() => state.tick(now()), intervalMs);
  timer.unref();
  return timer;
}

function startPeriodicSave(state, persist, options = {}) {
  const intervalMs = options.intervalMs || 30000;
  const timer = setInterval(() => saveState(state, persist), intervalMs);
  timer.unref();
  return timer;
}

function startPeriodicPidCheck(state, sessionsDir, options = {}) {
  const intervalMs = options.intervalMs || 10000;
  runSessionPidCheck(state, sessionsDir);
  const timer = setInterval(() => runSessionPidCheck(state, sessionsDir), intervalMs);
  timer.unref();
  return timer;
}

function stopAll(handles) {
  if (!handles) return;
  const values = Array.isArray(handles) ? handles : Object.values(handles);
  for (const handle of values) {
    if (handle) clearInterval(handle);
  }
}

function markResetFlag(persist) {
  try {
    ensurePersistenceDir(persist);
    fs.writeFileSync(persist.resetFlagFile, '', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function consumeResetFlag(persist) {
  try {
    if (!fs.existsSync(persist.resetFlagFile)) return false;
    fs.unlinkSync(persist.resetFlagFile);
    return true;
  } catch (_) {
    return false;
  }
}

function performDashboardHardReset(options = {}) {
  const command = options.command || 'watch';
  const persist = options.persist || resolvePersistPaths({ mode: command });
  const state = options.state || null;
  const mock = options.mock || null;
  const watcher = options.watcher || null;
  const preserveActiveRootAgents = options.preserveActiveRootAgents === true;

  clearPersistedFiles(persist);

  if (mock && typeof mock.hardReset === 'function') {
    mock.hardReset();
  } else if (state) {
    const liveSessionIds = command === 'watch' ? readLiveSessionIds(options.sessionsDir) : null;
    state.reset({
      preserveActiveRootAgents,
      liveSessionIds
    });
  }

  if (watcher && typeof watcher.resetToCurrentEnd === 'function') {
    watcher.resetToCurrentEnd().catch((error) => {
      process.stderr.write(`[watcher] hard reset re-prime failed: ${error.message}\n`);
    });
  } else if (command === 'watch') {
    markResetFlag(persist);
  }

  if (state) {
    saveState(state, persist);
    savePokedex(state, persist);
  }

  process.stdout.write(`[${command}] hard reset complete\n`);
}

module.exports = {
  normalizeMode,
  resolvePersistPaths,
  ensurePersistenceDir,
  saveState,
  loadState,
  savePokedex,
  loadPokedex,
  clearPersistedFiles,
  readLiveSessionIds,
  runStartupZombieBoxing,
  runSessionPidCheck,
  startPeriodicTick,
  startPeriodicSave,
  startPeriodicPidCheck,
  stopAll,
  markResetFlag,
  consumeResetFlag,
  performDashboardHardReset
};
