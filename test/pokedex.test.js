'use strict';

const { test, run } = require('./runner');
const assert = require('assert').strict;

const { EVENT_TYPES } = require('../parser');
const { AgentState } = require('../state');
const { getPokemonIdForAgent, resolveRenderedPokemonIdForAgent } = require('../pokemon');

test('state tracks discovered pokemon in snapshot and serialization', () => {
  const state = new AgentState({
    resolvePokemonId(agentId) {
      return agentId === 'agent-a' ? 25 : 133;
    }
  });

  state.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'agent-a',
    ts: 1,
    meta: { projectId: 'proj-a', sessionId: 'sess-a' }
  });
  state.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'agent-b',
    ts: 2,
    meta: { projectId: 'proj-b', sessionId: 'sess-b', sessionDisplayName: 'Main Session' }
  });
  state.applyEvent({
    type: EVENT_TYPES.TOOL_START,
    agentId: 'agent-a',
    ts: 3,
    meta: {}
  });

  assert.deepEqual(state.snapshot().pokedex.seenPokemonIds, [25, 133]);
  assert.equal(state.snapshot().pokedex.discoveredCount, 2);
  assert.deepEqual(state.serialize().seenPokemonIds, [25, 133]);
  assert.equal(state.snapshot().pokedex.firstDiscoveryByPokemon[25].projectId, 'proj-a');
  assert.equal(state.snapshot().pokedex.firstDiscoveryByPokemon[133].sessionId, 'sess-b');
});

test('state restore backfills discovered pokemon from restored agents', () => {
  const state = new AgentState({
    resolvePokemonId(agentId) {
      return agentId === 'boxed-agent' ? 152 : 7;
    }
  });

  const restored = state.restore({
    version: 1,
    agents: [
      {
        agentId: 'live-agent',
        name: 'live-agent',
        childrenIds: [],
        status: 'Thinking',
        activity: 'Active',
        lastSeen: 10,
        createdAt: 5,
        counters: {}
      }
    ],
    boxedAgents: [
      {
        agentId: 'boxed-agent'
      }
    ]
  });

  assert.equal(restored, true);
  assert.deepEqual(state.snapshot().pokedex.seenPokemonIds, [7, 152]);
  assert.equal(state.snapshot().pokedex.firstDiscoveryByPokemon[7].agentId, 'live-agent');
});

test('state reset clears agents, boxed entries, and pokedex progress', () => {
  const state = new AgentState({
    resolvePokemonId(agentId) {
      return agentId === 'live-agent' ? 7 : 25;
    }
  });

  state.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'live-agent',
    ts: 1,
    meta: { projectId: 'proj-a', sessionId: 'sess-a' }
  });
  state.applyEvent({
    type: EVENT_TYPES.AGENT_DONE,
    agentId: 'live-agent',
    ts: 2,
    meta: {}
  });

  state.reset({ emit: false });

  assert.deepEqual(state.snapshot().agents, []);
  assert.deepEqual(state.snapshot().boxedAgents, []);
  assert.deepEqual(state.snapshot().pokedex.seenPokemonIds, []);
  assert.equal(state.snapshot().pokedex.discoveredCount, 0);
});

test('subagent discoveries record rendered unevolved pokemon and parent info', () => {
  let lineage = null;

  for (let i = 1; i <= 500; i += 1) {
    const parentId = 'parent-agent-' + i;
    const childId = 'child-agent-' + i;
    const parentPokemonId = getPokemonIdForAgent(parentId);
    const childPokemonId = resolveRenderedPokemonIdForAgent(childId, { parentId });
    if (childPokemonId !== parentPokemonId) {
      lineage = { parentId, childId, childPokemonId };
      break;
    }
  }

  assert.ok(lineage, 'expected to find a deterministic parent/child lineage with different pokemon');

  const state = new AgentState({
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

  state.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: lineage.parentId,
    ts: 1,
    meta: { projectId: 'proj-a', sessionId: 'sess-a', sessionDisplayName: 'Main Agent' }
  });

  state.applyEvent({
    type: EVENT_TYPES.SUBAGENT_SPAWN,
    agentId: lineage.childId,
    ts: 2,
    meta: { parentId: lineage.parentId, projectId: 'proj-a', sessionId: 'sess-a', agentDescription: 'Worker Child' }
  });

  const pokedex = state.snapshot().pokedex;
  const childPokemonId = resolveRenderedPokemonIdForAgent(lineage.childId, {
    parentId: lineage.parentId,
    getAgentById(id) {
      return state.agents.get(id) || null;
    }
  });

  assert.ok(pokedex.seenPokemonIds.includes(childPokemonId));
  assert.equal(pokedex.firstDiscoveryByPokemon[childPokemonId].viaSubagent, true);
  assert.equal(pokedex.firstDiscoveryByPokemon[childPokemonId].parentId, lineage.parentId);
});

test('state restore backfills deep historical subagent lineages from history records', () => {
  let chain = null;

  for (let i = 1; i <= 500; i += 1) {
    const parentId = 'root-' + i;
    const childId = 'child-' + i;
    const grandchildId = 'grandchild-' + i;
    const parentPokemonId = getPokemonIdForAgent(parentId);
    const childPokemonId = resolveRenderedPokemonIdForAgent(childId, { parentId });
    const childBasePokemonId = getPokemonIdForAgent(childId);
    const grandchildCorrectPokemonId = resolveRenderedPokemonIdForAgent(grandchildId, {
      parentId: childId,
      createdAt: 30,
      getAgentById(id, options = {}) {
        const beforeTs = typeof options.beforeTs === 'number' ? options.beforeTs : Infinity;
        if (id === parentId && 10 <= beforeTs) {
          return { agentId: parentId, createdAt: 10 };
        }
        if (id === childId && 20 <= beforeTs) {
          return { agentId: childId, parentId, createdAt: 20 };
        }
        return null;
      }
    });
    const grandchildFallbackPokemonId = resolveRenderedPokemonIdForAgent(grandchildId, {
      parentId: childId,
      createdAt: 30
    });

    if (
      childPokemonId !== parentPokemonId &&
      childPokemonId !== childBasePokemonId &&
      grandchildCorrectPokemonId !== parentPokemonId &&
      grandchildCorrectPokemonId !== childPokemonId &&
      grandchildCorrectPokemonId !== grandchildFallbackPokemonId
    ) {
      chain = {
        parentId,
        childId,
        grandchildId,
        parentPokemonId,
        childPokemonId,
        grandchildCorrectPokemonId
      };
      break;
    }
  }

  assert.ok(chain, 'expected to find a deterministic deep lineage test chain');

  const state = new AgentState({
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

  const restored = state.restore({
    version: 1,
    savedAt: 100,
    seenPokemonIds: [],
    firstDiscoveryByPokemon: {},
    agents: [],
    boxedAgents: [
      {
        agentId: chain.parentId,
        projectId: 'proj-a',
        sessionId: 'sess-a',
        parentId: null,
        createdAt: 10,
        doneAt: 15,
        counters: {}
      }
    ],
    subagentHistory: [
      {
        agentId: chain.childId,
        projectId: 'proj-a',
        sessionId: 'sess-a',
        parentId: chain.parentId,
        createdAt: 20,
        doneAt: 25,
        counters: {}
      },
      {
        agentId: chain.grandchildId,
        projectId: 'proj-a',
        sessionId: 'sess-a',
        parentId: chain.childId,
        createdAt: 30,
        doneAt: 35,
        counters: {}
      }
    ]
  });

  const pokedex = state.snapshot().pokedex;
  assert.equal(restored, true);
  assert.ok(pokedex.seenPokemonIds.includes(chain.parentPokemonId));
  assert.ok(pokedex.seenPokemonIds.includes(chain.childPokemonId));
  assert.ok(pokedex.seenPokemonIds.includes(chain.grandchildCorrectPokemonId));
  assert.equal(pokedex.firstDiscoveryByPokemon[chain.childPokemonId].parentId, chain.parentId);
  assert.equal(pokedex.firstDiscoveryByPokemon[chain.grandchildCorrectPokemonId].parentId, chain.childId);
});

run();
