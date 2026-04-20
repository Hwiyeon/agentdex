'use strict';

const crypto = require('crypto');
const { EVENT_TYPES } = require('./parser');

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
      for (let i = unusedDescriptions.length - 1; i > 0; i -= 1) {
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
    for (const [id, agent] of agents) {
      if (agent.parentId === agentId) {
        ids.push(id, ...collectDescendants(id));
      }
    }
    return ids;
  }

  function completeAgent(agentId) {
    if (!agents.has(agentId)) return;

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

module.exports = {
  createMockDriver
};
