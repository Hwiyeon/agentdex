'use strict';

const { test, run } = require('./runner');
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { EVENT_TYPES } = require('../parser');
const { AgentState } = require('../state');
const {
  DEFAULTS,
  resolveConfig,
  getPersistencePaths,
  saveState,
  loadState,
  savePokedex,
  loadPokedex,
  clearPersistedFiles,
  performDashboardHardReset
} = require('../cli');

function createState(pokemonByAgent) {
  return new AgentState({
    resolvePokemonId(agentId) {
      return pokemonByAgent[agentId] || null;
    }
  });
}

function seedBoxedAgent(state, agentId, tsBase, meta) {
  state.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId,
    ts: tsBase,
    meta
  });
  state.applyEvent({
    type: EVENT_TYPES.AGENT_DONE,
    agentId,
    ts: tsBase + 1,
    meta: {}
  });
}

test('persistence paths are scoped by mode', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-persist-'));
  const watchPaths = getPersistencePaths('watch', tempRoot);
  const mockPaths = getPersistencePaths('mock', tempRoot);

  assert.notEqual(watchPaths.baseDir, mockPaths.baseDir);
  assert.equal(watchPaths.stateFile, path.join(tempRoot, 'data', 'state.json'));
  assert.equal(mockPaths.stateFile, path.join(tempRoot, 'data', 'runtime', 'mock', 'state.json'));
  assert.equal(watchPaths.pokedexFile, path.join(tempRoot, 'data', 'pokedex.json'));
  assert.equal(mockPaths.pokedexFile, path.join(tempRoot, 'data', 'runtime', 'mock', 'pokedex.json'));
});

test('pokeapi sprites are enabled by default', () => {
  const { config } = resolveConfig(['watch']);
  assert.equal(DEFAULTS.enablePokeapiSprites, true);
  assert.equal(config.enablePokeapiSprites, true);
});

test('no-pokeapi CLI flag disables pokeapi sprites', () => {
  const { config } = resolveConfig(['watch', '--no-pokeapi']);
  assert.equal(config.enablePokeapiSprites, false);
});

test('watch and mock persisted state restore independently', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-persist-'));
  const watchPaths = getPersistencePaths('watch', tempRoot);
  const mockPaths = getPersistencePaths('mock', tempRoot);

  const watchState = createState({ 'watch-agent': 25 });
  seedBoxedAgent(watchState, 'watch-agent', 1, { projectId: 'watch-project', sessionId: 'watch-session' });
  saveState(watchState, watchPaths);
  savePokedex(watchState, watchPaths);

  const mockState = createState({ 'mock-agent': 133 });
  seedBoxedAgent(mockState, 'mock-agent', 10, { projectId: 'mock-project', sessionId: 'mock-session' });
  saveState(mockState, mockPaths);
  savePokedex(mockState, mockPaths);

  const restoredWatch = createState({ 'watch-agent': 25 });
  const restoredMock = createState({ 'mock-agent': 133 });

  assert.equal(loadState(restoredWatch, watchPaths), true);
  assert.equal(loadPokedex(restoredWatch, watchPaths), true);
  assert.equal(loadState(restoredMock, mockPaths), true);
  assert.equal(loadPokedex(restoredMock, mockPaths), true);

  assert.deepEqual(restoredWatch.snapshot().boxedAgents.map((agent) => agent.agentId), ['watch-agent']);
  assert.deepEqual(restoredMock.snapshot().boxedAgents.map((agent) => agent.agentId), ['mock-agent']);
  assert.deepEqual(restoredWatch.snapshot().pokedex.seenPokemonIds, [25]);
  assert.deepEqual(restoredMock.snapshot().pokedex.seenPokemonIds, [133]);
});

test('clearing mock persisted files leaves watch persisted files untouched', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-persist-'));
  const watchPaths = getPersistencePaths('watch', tempRoot);
  const mockPaths = getPersistencePaths('mock', tempRoot);

  const watchState = createState({ 'watch-agent': 7 });
  const mockState = createState({ 'mock-agent': 152 });
  seedBoxedAgent(watchState, 'watch-agent', 1, { projectId: 'watch-project', sessionId: 'watch-session' });
  seedBoxedAgent(mockState, 'mock-agent', 2, { projectId: 'mock-project', sessionId: 'mock-session' });
  saveState(watchState, watchPaths);
  savePokedex(watchState, watchPaths);
  saveState(mockState, mockPaths);
  savePokedex(mockState, mockPaths);

  clearPersistedFiles(mockPaths);

  assert.equal(fs.existsSync(mockPaths.stateFile), false);
  assert.equal(fs.existsSync(mockPaths.pokedexFile), false);
  assert.equal(fs.existsSync(watchPaths.stateFile), true);
  assert.equal(fs.existsSync(watchPaths.pokedexFile), true);

  const restoredWatch = createState({ 'watch-agent': 7 });
  const restoredMock = createState({ 'mock-agent': 152 });

  assert.equal(loadState(restoredWatch, watchPaths), true);
  assert.equal(loadPokedex(restoredWatch, watchPaths), true);
  assert.equal(loadState(restoredMock, mockPaths), false);
  assert.equal(loadPokedex(restoredMock, mockPaths), false);
  assert.deepEqual(restoredWatch.snapshot().pokedex.seenPokemonIds, [7]);
});

test('hard-reset command clears only the selected mode persisted files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-persist-'));
  const cliPath = path.join(__dirname, '..', 'cli.js');
  const watchPaths = getPersistencePaths('watch', tempRoot);
  const mockPaths = getPersistencePaths('mock', tempRoot);

  const watchState = createState({ 'watch-agent': 25 });
  const mockState = createState({ 'mock-agent': 133 });
  seedBoxedAgent(watchState, 'watch-agent', 1, { projectId: 'watch-project', sessionId: 'watch-session' });
  seedBoxedAgent(mockState, 'mock-agent', 2, { projectId: 'mock-project', sessionId: 'mock-session' });
  saveState(watchState, watchPaths);
  savePokedex(watchState, watchPaths);
  saveState(mockState, mockPaths);
  savePokedex(mockState, mockPaths);

  const result = spawnSync(process.execPath, [cliPath, 'hard-reset', 'watch'], {
    cwd: tempRoot,
    encoding: 'utf8',
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(watchPaths.stateFile), false);
  assert.equal(fs.existsSync(watchPaths.pokedexFile), false);
  assert.equal(fs.existsSync(mockPaths.stateFile), true);
  assert.equal(fs.existsSync(mockPaths.pokedexFile), true);
});

test('watch dashboard hard reset does not invoke mock reset or clear mock persisted files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-persist-'));
  const watchPaths = getPersistencePaths('watch', tempRoot);
  const mockPaths = getPersistencePaths('mock', tempRoot);

  const watchState = createState({ 'watch-agent': 25 });
  const mockState = createState({ 'mock-agent': 133 });
  seedBoxedAgent(watchState, 'watch-agent', 1, { projectId: 'watch-project', sessionId: 'watch-session' });
  seedBoxedAgent(mockState, 'mock-agent', 2, { projectId: 'mock-project', sessionId: 'mock-session' });
  saveState(watchState, watchPaths);
  savePokedex(watchState, watchPaths);
  saveState(mockState, mockPaths);
  savePokedex(mockState, mockPaths);

  let mockHardResetCalled = false;
  performDashboardHardReset({
    command: 'watch',
    persist: watchPaths,
    state: watchState,
    mock: null
  });

  assert.equal(mockHardResetCalled, false);
  assert.equal(fs.existsSync(watchPaths.stateFile), true);
  assert.equal(fs.existsSync(watchPaths.pokedexFile), true);
  assert.equal(fs.existsSync(mockPaths.stateFile), true);
  assert.equal(fs.existsSync(mockPaths.pokedexFile), true);

  const watchSavedState = JSON.parse(fs.readFileSync(watchPaths.stateFile, 'utf8'));
  const mockSavedState = JSON.parse(fs.readFileSync(mockPaths.stateFile, 'utf8'));
  assert.deepEqual(watchSavedState.agents, []);
  assert.deepEqual(watchSavedState.boxedAgents, []);
  assert.deepEqual(watchSavedState.seenPokemonIds, []);
  assert.deepEqual(mockSavedState.boxedAgents.map((agent) => agent.agentId), ['mock-agent']);
});

test('watch dashboard hard reset clears all agents and history', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-persist-'));
  const watchPaths = getPersistencePaths('watch', tempRoot);
  const watchState = createState({ active: 25, sleeping: 26, child: 27 });
  const now = Date.now();

  watchState.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'active',
    ts: now - 500,
    meta: { projectId: 'watch-project', sessionId: 'active-session' }
  });
  watchState.applyEvent({
    type: EVENT_TYPES.ASSISTANT_OUTPUT,
    agentId: 'active',
    ts: now - 400,
    meta: { totalTokens: 9000 }
  });
  watchState.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'sleeping',
    ts: now - 70000,
    meta: { projectId: 'watch-project', sessionId: 'sleeping-session' }
  });
  watchState.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'child',
    ts: now - 300,
    meta: { projectId: 'watch-project', sessionId: 'child-session', parentId: 'active' }
  });
  watchState.tick(now);
  seedBoxedAgent(watchState, 'boxed-agent', now - 10000, { projectId: 'watch-project', sessionId: 'boxed-session' });

  let watcherResetCalls = 0;
  const watcher = {
    async resetToCurrentEnd() {
      watcherResetCalls += 1;
    }
  };

  performDashboardHardReset({
    command: 'watch',
    persist: watchPaths,
    state: watchState,
    watcher
  });

  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = watchState.snapshot();
  assert.deepEqual(snapshot.agents.map((agent) => agent.agentId), []);
  assert.deepEqual(snapshot.boxedAgents, []);
  assert.deepEqual(snapshot.subagentHistory, []);
  assert.deepEqual(snapshot.pokedex.seenPokemonIds, []);
  assert.equal(watcherResetCalls, 1);

  const savedState = JSON.parse(fs.readFileSync(watchPaths.stateFile, 'utf8'));
  assert.deepEqual(savedState.agents.map((agent) => agent.agentId), []);
  assert.deepEqual(savedState.boxedAgents, []);
  assert.deepEqual(savedState.subagentHistory, []);
  assert.deepEqual(savedState.seenPokemonIds, []);
});

test('mock dashboard hard reset uses mock reset path only', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-persist-'));
  const watchPaths = getPersistencePaths('watch', tempRoot);
  const mockPaths = getPersistencePaths('mock', tempRoot);

  const watchState = createState({ 'watch-agent': 25 });
  const mockState = createState({ 'mock-agent': 133 });
  seedBoxedAgent(watchState, 'watch-agent', 1, { projectId: 'watch-project', sessionId: 'watch-session' });
  seedBoxedAgent(mockState, 'mock-agent', 2, { projectId: 'mock-project', sessionId: 'mock-session' });
  saveState(watchState, watchPaths);
  savePokedex(watchState, watchPaths);
  saveState(mockState, mockPaths);
  savePokedex(mockState, mockPaths);

  let mockHardResetCalled = false;
  const mockDriver = {
    hardReset() {
      mockHardResetCalled = true;
      mockState.reset();
    }
  };

  performDashboardHardReset({
    command: 'mock',
    persist: mockPaths,
    state: mockState,
    mock: mockDriver
  });

  assert.equal(mockHardResetCalled, true);
  assert.equal(fs.existsSync(watchPaths.stateFile), true);
  assert.equal(fs.existsSync(mockPaths.stateFile), true);

  const watchSavedState = JSON.parse(fs.readFileSync(watchPaths.stateFile, 'utf8'));
  const mockSavedState = JSON.parse(fs.readFileSync(mockPaths.stateFile, 'utf8'));
  assert.deepEqual(watchSavedState.boxedAgents.map((agent) => agent.agentId), ['watch-agent']);
  assert.deepEqual(mockSavedState.boxedAgents, []);
  assert.deepEqual(mockSavedState.seenPokemonIds, []);
});

run();
