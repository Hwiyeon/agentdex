'use strict';

const assert = require('assert').strict;
const EventEmitter = require('events');
const { test, run } = require('./runner');
const { createWebviewBridge } = require('../extension/src/webviewBridge');

function createPanel() {
  const sent = [];
  let receive = null;
  let onDispose = null;

  return {
    sent,
    panel: {
      webview: {
        postMessage(message) {
          sent.push(message);
        },
        onDidReceiveMessage(callback) {
          receive = callback;
          return { dispose() {} };
        }
      },
      onDidDispose(callback) {
        onDispose = callback;
        return { dispose() {} };
      }
    },
    receive(message) {
      receive(message);
    },
    dispose() {
      onDispose();
    }
  };
}

test('webview bridge waits for ready before sending state and handles actions', () => {
  const state = new EventEmitter();
  state.snapshot = () => ({
    now: 1,
    lastUpdate: 1,
    activeTimeoutSec: 10,
    staleTimeoutSec: 20,
    activeAgentCount: 0,
    pokedex: { seenPokemonIds: [], firstDiscoveryByPokemon: {}, discoveredCount: 0, totalCount: 251 },
    agents: [],
    recentEvents: [],
    boxedAgents: [],
    subagentHistory: []
  });

  const calls = [];
  state.manualBox = (id) => { calls.push(['box', id]); return true; };
  state.manualUnbox = (id) => { calls.push(['unbox', id]); return true; };

  const watcher = new EventEmitter();
  const warnings = [];
  let hardResetCount = 0;
  const bridge = createWebviewBridge({
    state,
    watcher,
    publicConfig: {
      mode: 'watch',
      enablePokeapiSprites: true,
      supportsHardReset: true
    },
    onWarning(message) {
      warnings.push(message);
    },
    onHardReset() {
      hardResetCount += 1;
    }
  });

  const fixture = createPanel();
  const attached = bridge.attach(fixture.panel);

  assert.equal(fixture.sent.length, 0);

  fixture.receive({ type: 'ready' });
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].type, 'state');
  assert.equal(fixture.sent[0].snapshot.config.mode, 'watch');

  fixture.receive({ type: 'box', id: 'agent-1' });
  fixture.receive({ type: 'unbox', id: 'agent-2' });
  fixture.receive({ type: 'hardReset' });
  assert.deepEqual(calls, [['box', 'agent-1'], ['unbox', 'agent-2']]);
  assert.equal(hardResetCount, 1);

  state.emit('update');
  assert.equal(fixture.sent.length, 2);
  assert.equal(fixture.sent[1].type, 'state');

  watcher.emit('warn', 'careful');
  assert.equal(warnings[0], 'careful');
  assert.equal(fixture.sent[2].type, 'toast');

  fixture.dispose();
  state.emit('update');
  assert.equal(fixture.sent.length, 3);

  attached.dispose();
  bridge.dispose();
});

run();
