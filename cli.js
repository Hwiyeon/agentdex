#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { EVENT_TYPES, setExtendedContext, setAutoCompactRatio } = require('./parser');
const { AgentState } = require('./state');
const { TranscriptWatcher } = require('./watcher');
const { DashboardServer } = require('./server');
const { POKEDEX_MAX, resolveRenderedPokemonIdForAgent } = require('./pokemon');

const DEFAULTS = {
  port: 8123,
  host: '127.0.0.1',
  claudeProjectsPath: path.join(os.homedir(), '.claude', 'projects'),
  activeTimeoutSec: 600,
  staleTimeoutSec: 28800,
  enablePokeapiSprites: true
};
const MOCK_TIMEOUT_DEFAULTS = {
  activeTimeoutSec: 8,
  staleTimeoutSec: 120
};

function normalizeMode(mode) {
  return mode === 'mock' ? 'mock' : 'watch';
}

function isSupportedMode(mode) {
  return mode === 'watch' || mode === 'mock';
}

function getPersistencePaths(mode, cwd = process.cwd()) {
  const scope = normalizeMode(mode);
  const baseDir = scope === 'mock'
    ? path.join(cwd, 'data', 'runtime', 'mock')
    : path.join(cwd, 'data');
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

function readLiveSessionIds() {
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  const liveSessionIds = new Set();
  let files;
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return liveSessionIds; // sessions dir may not exist
  }
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
      const data = JSON.parse(raw);
      if (data.sessionId && data.pid) {
        try {
          process.kill(data.pid, 0);
          liveSessionIds.add(data.sessionId); // process alive
        } catch (_) {
          // process dead — skip
        }
      }
    } catch (_) {
      // skip malformed files
    }
  }
  return liveSessionIds;
}

function performDashboardHardReset(options) {
  const command = options && options.command ? options.command : 'watch';
  const persist = options && options.persist ? options.persist : getPersistencePaths(command);
  const state = options && options.state;
  const mock = options && options.mock ? options.mock : null;
  const watcher = options && options.watcher ? options.watcher : null;

  clearPersistedFiles(persist);

  if (mock) {
    mock.hardReset();
  } else if (state) {
    const liveSessionIds = command === 'watch' ? readLiveSessionIds() : null;
    state.reset({
      preserveActiveRootAgents: false,
      liveSessionIds
    });
  }

  if (watcher && typeof watcher.resetToCurrentEnd === 'function') {
    watcher.resetToCurrentEnd().catch((error) => {
      process.stderr.write(`[watcher] hard reset re-prime failed: ${error.message}\n`);
    });
  }

  if (state) {
    saveState(state, persist);
    savePokedex(state, persist);
  }

  process.stdout.write(`[${command}] hard reset complete\n`);
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

function expandHome(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return rawPath;
  }
  if (rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function parseBoolean(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null) {
    return fallback;
  }
  const value = String(rawValue).trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  return fallback;
}

function parseNumber(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgv(argv) {
  const out = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }

    if (token === '--pokeapi') {
      out.enablePokeapiSprites = true;
      continue;
    }
    if (token === '--no-pokeapi') {
      out.enablePokeapiSprites = false;
      continue;
    }

    const eqIndex = token.indexOf('=');
    let key;
    let value;

    if (eqIndex >= 0) {
      key = token.slice(2, eqIndex);
      value = token.slice(eqIndex + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = 'true';
      }
    }

    out[key] = value;
  }

  return out;
}

function loadConfigFile(filePath) {
  const resolved = path.resolve(filePath || path.join(process.cwd(), 'config.json'));
  if (!fs.existsSync(resolved)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse config file (${resolved}): ${error.message}`);
  }
}

function resolveConfig(argv) {
  const argMap = parseArgv(argv);
  const command = argMap.help ? 'help' : argMap._[0] || 'watch';
  const configFile = argMap.config || path.join(process.cwd(), 'config.json');

  const fileConfig = loadConfigFile(configFile);

  const envConfig = {
    port: process.env.PORT,
    host: process.env.HOST,
    claudeProjectsPath: process.env.CLAUDE_PROJECTS_PATH,
    activeTimeoutSec: process.env.ACTIVE_TIMEOUT_SEC,
    staleTimeoutSec: process.env.STALE_TIMEOUT_SEC,
    enablePokeapiSprites: process.env.ENABLE_POKEAPI_SPRITES
  };

  const cliConfig = {
    port: argMap.port,
    host: argMap.host,
    claudeProjectsPath: argMap.claudeProjectsPath || argMap.path || argMap.claudePath,
    activeTimeoutSec: argMap.activeTimeoutSec || argMap.activeTimeout,
    staleTimeoutSec: argMap.staleTimeoutSec || argMap.staleTimeout,
    enablePokeapiSprites: argMap.enablePokeapiSprites
  };

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...cliConfig
  };

  const config = {
    port: parseNumber(merged.port, DEFAULTS.port),
    host: merged.host || DEFAULTS.host,
    claudeProjectsPath: path.resolve(expandHome(merged.claudeProjectsPath || DEFAULTS.claudeProjectsPath)),
    activeTimeoutSec: parseNumber(merged.activeTimeoutSec, DEFAULTS.activeTimeoutSec),
    staleTimeoutSec: parseNumber(merged.staleTimeoutSec, DEFAULTS.staleTimeoutSec),
    enablePokeapiSprites: parseBoolean(merged.enablePokeapiSprites, DEFAULTS.enablePokeapiSprites)
  };

  if (command === 'mock') {
    if (config.activeTimeoutSec === DEFAULTS.activeTimeoutSec) {
      config.activeTimeoutSec = MOCK_TIMEOUT_DEFAULTS.activeTimeoutSec;
    }
    if (config.staleTimeoutSec === DEFAULTS.staleTimeoutSec) {
      config.staleTimeoutSec = MOCK_TIMEOUT_DEFAULTS.staleTimeoutSec;
    }
  }

  return {
    command,
    config
  };
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

function nowMs() {
  return Date.now();
}

function createMockDriver(state) {
  const agents = new Map();
  const activeTimeoutMs = Math.max(1000, Number(state && state.activeTimeoutMs) || 60000);
  const sessionTemplates = [
    { projectId: 'web-frontend', sessionId: 'feat-dashboard' },
    { projectId: 'api-server', sessionId: 'fix-auth-bug' },
    { projectId: 'design-system', sessionId: 'refresh-tokens' },
    { projectId: 'infra-tools', sessionId: 'repair-ci-cache' },
    { projectId: 'mobile-app', sessionId: 'ship-onboarding' },
    { projectId: 'data-pipeline', sessionId: 'backfill-embeddings' }
  ];
  const MOCK_TICK_MS = 900;
  const MOCK_ROOT_TARGET = 4;
  const MOCK_MAX_AGENTS = 18;
  const MOCK_ROOT_COMPLETE_CHANCE = 0.08;
  const MOCK_SUBAGENT_COMPLETE_CHANCE = 0.16;
  const MOCK_SPAWN_CHANCE = 0.38;
  const MOCK_ROOT_MIN_LIFETIME_MS = 18000;
  const MOCK_ROOT_LIFETIME_JITTER_MS = 18000;
  const MOCK_SUB_MIN_LIFETIME_MS = 6000;
  const MOCK_SUB_LIFETIME_JITTER_MS = 12000;
  const MOCK_MAX_SUBAGENT_DEPTH = 2;
  const MOCK_SLEEP_ROOT_TARGET = 1;
  const MOCK_SLEEP_BUFFER_MS = Math.max(1500, Math.floor(activeTimeoutMs * 0.35));
  const MOCK_SLEEP_JITTER_MS = Math.max(2000, Math.floor(activeTimeoutMs * 0.6));

  let timer = null;
  const doneTimers = new Set();
  let rootCounter = 0;

  function trackTimer(timeout) {
    doneTimers.add(timeout);
    timeout.unref();
    return timeout;
  }

  function clearDoneTimers() {
    for (const timeout of doneTimers) {
      clearTimeout(timeout);
    }
    doneTimers.clear();
  }

  function randomAgent() {
    const ts = nowMs();
    const all = Array.from(agents.values()).filter((agent) => !isSleepingMockAgent(agent, ts));
    if (all.length === 0) {
      return null;
    }
    return all[Math.floor(Math.random() * all.length)];
  }

  function randomRootAgent(options = {}) {
    const ts = typeof options.ts === 'number' ? options.ts : nowMs();
    const allowSleeping = options.allowSleeping === true;
    const roots = Array.from(agents.values()).filter((agent) => {
      if (agent.parentId) return false;
      if (!allowSleeping && isSleepingMockAgent(agent, ts)) return false;
      return true;
    });
    if (roots.length === 0) {
      return null;
    }
    return roots[Math.floor(Math.random() * roots.length)];
  }

  function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function countRootAgents() {
    let count = 0;
    for (const agent of agents.values()) {
      if (!agent.parentId) count += 1;
    }
    return count;
  }

  function agentDepth(agent) {
    let depth = 0;
    let current = agent;
    while (current && current.parentId) {
      depth += 1;
      current = agents.get(current.parentId) || null;
      if (depth > 8) break;
    }
    return depth;
  }

  function scheduleCompletion(agentId, minLifetimeMs, jitterMs) {
    const lifetime = minLifetimeMs + Math.floor(Math.random() * jitterMs);
    const doneTimer = trackTimer(setTimeout(() => {
      doneTimers.delete(doneTimer);
      completeAgent(agentId);
    }, lifetime));
  }

  function isSleepingMockAgent(agent, ts = nowMs()) {
    return !!(agent && typeof agent.sleepUntil === 'number' && agent.sleepUntil > ts);
  }

  function sleepDurationMs() {
    return activeTimeoutMs + MOCK_SLEEP_BUFFER_MS + Math.floor(Math.random() * MOCK_SLEEP_JITTER_MS);
  }

  function sleepingRootCount(ts = nowMs()) {
    let count = 0;
    for (const agent of agents.values()) {
      if (!agent.parentId && isSleepingMockAgent(agent, ts)) {
        count += 1;
      }
    }
    return count;
  }

  function maybeQueueSleepingRoot(ts = nowMs()) {
    if (sleepingRootCount(ts) >= Math.min(MOCK_SLEEP_ROOT_TARGET, countRootAgents())) {
      return;
    }

    const target = randomRootAgent({ ts, allowSleeping: false });
    if (!target) {
      return;
    }

    target.sleepUntil = ts + sleepDurationMs();
  }

  function addRootAgent() {
    const template = sessionTemplates[Math.floor(Math.random() * sessionTemplates.length)];
    const runId = String(++rootCounter).padStart(2, '0');
    const sessionId = `${template.sessionId}-${runId}`;
    const agentId = `${sessionId}:main`;
    const contextMax = 160000 + randomInt(0, 80000);
    const session = {
      projectId: template.projectId,
      sessionId
    };

    agents.set(agentId, {
      agentId,
      parentId: undefined,
      projectId: session.projectId,
      sessionId: session.sessionId,
      contextUsed: 0,
      contextMax,
      sleepUntil: 0
    });

    state.applyEvent({
      type: EVENT_TYPES.AGENT_SEEN,
      agentId,
      ts: nowMs(),
      meta: { ...session, contextUsed: 0, contextMax }
    });
    emitMockCommand(agents.get(agentId), nowMs());

    scheduleCompletion(agentId, MOCK_ROOT_MIN_LIFETIME_MS, MOCK_ROOT_LIFETIME_JITTER_MS);
  }

  function ensureRootAgents() {
    while (countRootAgents() < MOCK_ROOT_TARGET && agents.size < MOCK_MAX_AGENTS) {
      addRootAgent();
    }
  }

  const MOCK_DESCRIPTIONS = [
    { description: 'search config files', subagentType: 'Explore' },
    { description: 'run unit tests', subagentType: 'general-purpose' },
    { description: 'find API endpoints', subagentType: 'Explore' },
    { description: 'fix lint errors', subagentType: 'general-purpose' },
    { description: 'review PR changes', subagentType: 'Plan' },
    { description: 'update dependencies', subagentType: 'general-purpose' },
    { description: 'explore auth module', subagentType: 'Explore' },
    { description: 'refactor database layer', subagentType: 'general-purpose' },
    { description: 'check build status', subagentType: 'general-purpose' },
    { description: 'analyze test coverage', subagentType: 'Plan' },
    { description: 'migrate schema', subagentType: 'general-purpose' },
    { description: 'scan for vulnerabilities', subagentType: 'Explore' },
    { description: 'generate API docs', subagentType: 'general-purpose' },
    { description: 'profile memory usage', subagentType: 'Explore' },
    { description: 'design caching strategy', subagentType: 'Plan' },
    { description: 'validate input schemas', subagentType: 'general-purpose' },
    { description: 'trace request flow', subagentType: 'Explore' },
    { description: 'benchmark query perf', subagentType: 'general-purpose' }
  ];
  const MOCK_COMMANDS = [
    'npm test',
    'git status --short',
    'rg -n "TODO|FIXME" .',
    'sed -n "1,180p" public/app.js',
    'node cli.js mock',
    'node test/claude-code-transcripts.test.js',
    'find . -maxdepth 2 -type f',
    'ls -la'
  ];
  let unusedDescriptions = [];

  function pickDescription() {
    if (unusedDescriptions.length === 0) {
      unusedDescriptions = MOCK_DESCRIPTIONS.slice();
      for (let i = unusedDescriptions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = unusedDescriptions[i];
        unusedDescriptions[i] = unusedDescriptions[j];
        unusedDescriptions[j] = tmp;
      }
    }
    return unusedDescriptions.pop();
  }

  function buildMockUsage(target) {
    const isSubagent = !!target.parentId;
    const inputTokens = isSubagent ? randomInt(2500, 14000) : randomInt(12000, 65000);
    const outputTokens = isSubagent ? randomInt(900, 6500) : randomInt(4000, 26000);
    const cacheRead = Math.random() < 0.42 ? randomInt(Math.floor(inputTokens * 0.15), Math.floor(inputTokens * 0.9)) : 0;
    const cacheCreate = Math.random() < 0.24 ? randomInt(Math.floor(inputTokens * 0.08), Math.floor(inputTokens * 0.45)) : 0;

    return {
      inputTokens,
      outputTokens,
      cacheRead,
      cacheCreate,
      contextUsed: inputTokens + cacheRead + cacheCreate,
      totalTokens: inputTokens + outputTokens + cacheRead + cacheCreate
    };
  }

  function pickMockCommand() {
    return MOCK_COMMANDS[Math.floor(Math.random() * MOCK_COMMANDS.length)];
  }

  function emitMockCommand(target, ts, totalTokens) {
    if (!target) {
      return;
    }

    const eventTs = typeof ts === 'number' ? ts : nowMs();
    const toolMeta = {
      projectId: target.projectId,
      sessionId: target.sessionId,
      parentId: target.parentId,
      contextUsed: target.contextUsed,
      contextMax: target.contextMax,
      totalTokens: typeof totalTokens === 'number' ? totalTokens : 0,
      toolName: 'bash',
      lastCommand: pickMockCommand()
    };

    state.applyEvent({
      type: EVENT_TYPES.TOOL_START,
      agentId: target.agentId,
      ts: eventTs,
      meta: toolMeta
    });
    state.applyEvent({
      type: EVENT_TYPES.TOOL_END,
      agentId: target.agentId,
      ts: eventTs + 150,
      meta: toolMeta
    });
  }

  function spawnSubAgent() {
    const candidates = Array.from(agents.values()).filter((agent) => agentDepth(agent) < MOCK_MAX_SUBAGENT_DEPTH);
    if (candidates.length === 0) {
      return;
    }
    const parent = candidates[Math.floor(Math.random() * candidates.length)];
    if (!parent) {
      return;
    }

    const childId = `${parent.sessionId}:sub-${crypto.randomBytes(2).toString('hex')}`;
    if (agents.has(childId)) {
      return;
    }

    const mockDesc = pickDescription();
    const contextMax = 80000 + Math.floor(Math.random() * 120000);
    const meta = {
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      parentId: parent.agentId,
      agentDescription: mockDesc.description,
      subagentType: mockDesc.subagentType,
      contextUsed: 0,
      contextMax
    };

    agents.set(childId, {
      agentId: childId,
      parentId: parent.agentId,
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      contextUsed: 0,
      contextMax,
      sleepUntil: 0
    });

    state.applyEvent({
      type: EVENT_TYPES.SUBAGENT_SPAWN,
      agentId: childId,
      ts: nowMs(),
      meta
    });
    emitMockCommand(agents.get(childId), nowMs());

    scheduleCompletion(childId, MOCK_SUB_MIN_LIFETIME_MS, MOCK_SUB_LIFETIME_JITTER_MS);
  }

  function collectDescendants(agentId) {
    const ids = [];
    for (const [id, a] of agents) {
      if (a.parentId === agentId) {
        ids.push(id, ...collectDescendants(id));
      }
    }
    return ids;
  }

  function completeAgent(agentId) {
    if (!agents.has(agentId)) return;

    // Remove all descendants from mock map first
    const descendants = collectDescendants(agentId);
    for (const id of descendants) {
      agents.delete(id);
    }
    agents.delete(agentId);

    state.applyEvent({
      type: EVENT_TYPES.AGENT_DONE,
      agentId,
      ts: nowMs(),
      meta: {}
    });
  }

  function emitRandomActivity() {
    const target = randomAgent();
    if (!target) {
      return;
    }
    target.sleepUntil = 0;

    const mockUsage = buildMockUsage(target);
    target.contextUsed = Math.min(target.contextUsed + mockUsage.contextUsed, target.contextMax);

    const ts = nowMs();
    const baseMeta = {
      projectId: target.projectId,
      sessionId: target.sessionId,
      parentId: target.parentId,
      contextUsed: target.contextUsed,
      contextMax: target.contextMax,
      totalTokens: mockUsage.totalTokens
    };

    state.applyEvent({
      type: EVENT_TYPES.AGENT_SEEN,
      agentId: target.agentId,
      ts,
      meta: baseMeta
    });

    const completeChance = target.parentId ? MOCK_SUBAGENT_COMPLETE_CHANCE : MOCK_ROOT_COMPLETE_CHANCE;
    if (Math.random() < completeChance) {
      completeAgent(target.agentId);
      return;
    }

    const roll = Math.random();
    if (roll < 0.25) {
      const toolName = ['bash', 'read_file', 'search', 'edit'][Math.floor(Math.random() * 4)];
      if (toolName === 'bash') {
        emitMockCommand(target, ts, mockUsage.totalTokens);
        return;
      }
      const toolMeta = { ...baseMeta, toolName };
      state.applyEvent({
        type: EVENT_TYPES.TOOL_START,
        agentId: target.agentId,
        ts,
        meta: toolMeta
      });
      state.applyEvent({
        type: EVENT_TYPES.TOOL_END,
        agentId: target.agentId,
        ts: ts + 150,
        meta: toolMeta
      });
      return;
    }

    if (roll < 0.8) {
      state.applyEvent({
        type: EVENT_TYPES.ASSISTANT_OUTPUT,
        agentId: target.agentId,
        ts,
        meta: baseMeta
      });
      return;
    }

    state.applyEvent({
      type: EVENT_TYPES.WAITING,
      agentId: target.agentId,
      ts,
      meta: baseMeta
    });
  }

  return {
    start() {
      ensureRootAgents();
      maybeQueueSleepingRoot(nowMs());
      timer = setInterval(() => {
        ensureRootAgents();
        maybeQueueSleepingRoot(nowMs());
        if (Math.random() < MOCK_SPAWN_CHANCE && agents.size < MOCK_MAX_AGENTS) {
          spawnSubAgent();
        }
        emitRandomActivity();
      }, MOCK_TICK_MS);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clearDoneTimers();
    },
    hardReset() {
      clearDoneTimers();
      agents.clear();
      rootCounter = 0;
      state.reset();
      ensureRootAgents();
    }
  };
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
    try {
      ensurePersistenceDir(persist);
      fs.writeFileSync(persist.resetFlagFile, '', 'utf8');
    } catch (_) { /* best-effort */ }
    process.stdout.write(`[hard-reset] cleared persisted ${targetMode} files in ${persist.baseDir}\n`);
    return;
  }

  if (command !== 'watch' && command !== 'mock') {
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

  // Read Claude Code settings (cross-platform: os.homedir() → ~/.claude on
  // Linux/macOS, %USERPROFILE%\.claude on Windows). Project-scoped files take
  // precedence over the user-global file, matching Claude Code's own order.
  const settingsCandidates = [
    path.join(process.cwd(), '.claude', 'settings.local.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json')
  ];
  const loadedSettings = [];
  for (const p of settingsCandidates) {
    try {
      loadedSettings.push({ path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) });
    } catch (_) { /* missing or unreadable — skip */ }
  }

  // Detect extended context (1M) from the first settings file that sets a model.
  let modelSetting = '';
  for (const { data } of loadedSettings) {
    if (typeof data.model === 'string' && data.model) { modelSetting = data.model; break; }
  }
  const extended = modelSetting.includes('[1m]');
  setExtendedContext(extended);
  process.stdout.write(`[config] claude model="${modelSetting}" extendedContext=${extended}\n`);

  // Detect CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. Precedence: process env > project
  // local > project shared > user global. Stored as 1–100 integer percent.
  let autoCompactPct = null;
  let autoCompactSource = null;
  const envOverride = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (envOverride !== undefined && envOverride !== '') {
    const v = Number(envOverride);
    if (Number.isFinite(v) && v > 0 && v <= 100) {
      autoCompactPct = v;
      autoCompactSource = 'process.env';
    }
  }
  if (autoCompactPct === null) {
    for (const { path: p, data } of loadedSettings) {
      const raw = data && data.env && data.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
      if (raw === undefined || raw === null || raw === '') continue;
      const v = Number(raw);
      if (Number.isFinite(v) && v > 0 && v <= 100) {
        autoCompactPct = v;
        autoCompactSource = p;
        break;
      }
    }
  }
  if (autoCompactPct !== null) {
    setAutoCompactRatio(autoCompactPct / 100);
    process.stdout.write(`[config] CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${autoCompactPct} (source=${autoCompactSource})\n`);
  }

  // Restore persisted state from disk
  loadState(state, persist);
  loadPokedex(state, persist);

  // Startup cleanup: box dead agents, suppress their sessions so the watcher
  // won't recreate them from old transcript events.  Box history is preserved.
  if (command === 'watch') {
    const liveSessionIds = readLiveSessionIds();
    let boxed = 0;

    // Move active agents with dead processes into the box
    for (const [agentId, agent] of [...state.agents.entries()]) {
      if (agent.parentId) continue; // subagents handled with their parent
      if (liveSessionIds.has(agent.sessionId)) continue; // still alive
      state.boxAgent(agent);
      state.removeAgent(agentId);
      boxed++;
    }

    // Suppress sessions to block ghost re-spawns from old transcript events.
    // - Dead active agent sessions: prevent zombie re-creation
    // - ALL boxed agent sessions (alive or dead): prevent auto-unbox from old events
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

    if (boxed > 0) {
      process.stdout.write(`[startup] boxed ${boxed} stale agent(s), ${state.agents.size} live agent(s) preserved\n`);
      saveState(state, persist);
    }
  }

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

  let watcher = null;
  let mock = null;

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
    let skipInitialTail = false;
    try {
      if (fs.existsSync(persist.resetFlagFile)) {
        skipInitialTail = true;
        fs.unlinkSync(persist.resetFlagFile);
        process.stdout.write('[persist] hard-reset flag detected — skipping initial transcript tail read\n');
      }
    } catch (_) { /* best-effort */ }
    await watcher.start({ skipInitialTail });
  }

  if (mock) {
    mock.start();
    process.stdout.write('[mock] synthetic event generator started\n');
  }

  const tickTimer = setInterval(() => state.tick(Date.now()), 1000);
  tickTimer.unref();

  // Session PID monitor: scan ~/.claude/sessions/ and check liveness
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  function runSessionPidCheck() {
    let files;
    try {
      files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    } catch (_) {
      // sessions dir may not exist — still call with empty map so that
      // restored agents whose session files were cleaned up get boxed.
      state.checkSessionPids(new Map(), true);
      return;
    }

    const sessionPidMap = new Map();
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
        const data = JSON.parse(raw);
        if (data.sessionId && data.pid) {
          sessionPidMap.set(data.sessionId, data.pid);
        }
      } catch (_) {
        // skip malformed files
      }
    }

    state.checkSessionPids(sessionPidMap, true);
  }

  let pidCheckTimer = null;
  if (command === 'watch') {
    // Run immediately on startup to clean up zombies from prior session/reboot
    runSessionPidCheck();
    pidCheckTimer = setInterval(runSessionPidCheck, 10000);
    pidCheckTimer.unref();
  }

  // Periodic state save (every 30 seconds)
  const saveTimer = setInterval(() => saveState(state, persist), 30000);
  saveTimer.unref();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    process.stdout.write(`\n[shutdown] received ${signal}, stopping...\n`);

    clearInterval(tickTimer);
    if (pidCheckTimer) clearInterval(pidCheckTimer);
    clearInterval(saveTimer);
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
  run
};

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
