'use strict';

const assert = require('assert').strict;
const { test, run } = require('./runner');
const { DashboardServer } = require('../server');
const { buildPublicSnapshot } = require('../snapshotPayload');

test('dashboard server snapshot payload uses the shared public snapshot builder', () => {
  const state = {
    on() {},
    off() {},
    snapshot() {
      return {
        now: 1,
        lastUpdate: 2,
        activeTimeoutSec: 10,
        staleTimeoutSec: 20,
        activeAgentCount: 1,
        pokedex: { seenPokemonIds: [25], firstDiscoveryByPokemon: {}, discoveredCount: 1, totalCount: 251 },
        agents: [{ agentId: 'a-1' }],
        recentEvents: [],
        boxedAgents: [],
        subagentHistory: []
      };
    }
  };

  const publicConfig = {
    mode: 'mock',
    enablePokeapiSprites: true,
    isMockMode: true,
    supportsHardReset: true
  };

  const server = new DashboardServer({
    state,
    publicConfig
  });

  assert.deepEqual(
    server.snapshotPayload(),
    buildPublicSnapshot(state, publicConfig)
  );
});

run();
