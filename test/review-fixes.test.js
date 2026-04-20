'use strict';

const { test, run } = require('./runner');
const assert = require('assert').strict;
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const { EVENT_TYPES, normalizeLine } = require('../parser');
const { AgentState } = require('../state');
const { TranscriptWatcher } = require('../watcher');

test('CLI supports --help without starting the server', () => {
  const cliPath = path.join(__dirname, '..', 'cli.js');
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.equal(result.stderr, '');
});

test('package entry can be required without vscode installed', () => {
  const pkg = require('..');

  assert.equal(typeof pkg.activate, 'function');
  assert.equal(typeof pkg.run, 'function');
});

test('package entry supports node dot help', () => {
  const repoRoot = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, ['.', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.equal(result.stderr, '');
});

test('explicit spawn events do not create a ghost agent id', () => {
  const events = normalizeLine(
    JSON.stringify({
      type: 'subagent_spawn',
      projectId: 'project-a',
      sessionId: 'session-a',
      parentId: 'parent-1',
      childAgentId: 'child-1'
    }),
    {
      filePath: '/tmp/project-a/session-a.jsonl',
      configuredRoot: '/tmp'
    }
  );

  assert.equal(events[0].type, EVENT_TYPES.AGENT_SEEN);
  assert.equal(events[0].agentId, 'child-1');
  assert.equal(events[1].type, EVENT_TYPES.SUBAGENT_SPAWN);
  assert.equal(events[1].agentId, 'child-1');
  assert.equal(events[1].meta.parentId, 'parent-1');
});

test('state creates a placeholder parent without self-linking on spawn', () => {
  const state = new AgentState();

  state.applyEvent({
    type: EVENT_TYPES.SUBAGENT_SPAWN,
    agentId: 'child-1',
    ts: 1,
    meta: {
      parentId: 'parent-1',
      projectId: 'project-a',
      sessionId: 'session-a'
    }
  });

  const parent = state.agents.get('parent-1');
  const child = state.agents.get('child-1');

  assert.ok(parent);
  assert.ok(child);
  assert.equal(parent.parentId, undefined);
  assert.deepEqual(Array.from(parent.childrenIds), ['child-1']);
  assert.equal(child.parentId, 'parent-1');
});

test('assistant output tokens roll up from child agents to parents', () => {
  const state = new AgentState();

  state.applyEvent({
    type: EVENT_TYPES.SUBAGENT_SPAWN,
    agentId: 'child-1',
    ts: 1,
    meta: {
      parentId: 'parent-1',
      projectId: 'project-a',
      sessionId: 'session-a'
    }
  });

  state.applyEvent({
    type: EVENT_TYPES.ASSISTANT_OUTPUT,
    agentId: 'child-1',
    ts: 2,
    meta: {
      totalTokens: 750
    }
  });

  const parent = state.agents.get('parent-1');
  const child = state.agents.get('child-1');

  assert.equal(child.selfTokens, 750);
  assert.equal(child.totalTokens, 750);
  assert.equal(parent.selfTokens, 0);
  assert.equal(parent.totalTokens, 750);
});

test('seen counter only increments for AGENT_SEEN events', () => {
  const state = new AgentState();

  state.applyEvent({
    type: EVENT_TYPES.TOOL_START,
    agentId: 'agent-1',
    ts: 1,
    meta: {}
  });
  state.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'agent-1',
    ts: 2,
    meta: {}
  });

  assert.equal(state.agents.get('agent-1').counters.seen, 1);
});

test('subagents are removed on done without entering the box', () => {
  const state = new AgentState();

  state.applyEvent({
    type: EVENT_TYPES.SUBAGENT_SPAWN,
    agentId: 'child-1',
    ts: 1,
    meta: {
      parentId: 'parent-1',
      projectId: 'project-a',
      sessionId: 'session-a'
    }
  });

  state.applyEvent({
    type: EVENT_TYPES.AGENT_DONE,
    agentId: 'child-1',
    ts: 2,
    meta: {}
  });

  assert.equal(state.agents.has('child-1'), false);
  assert.equal(state.boxedAgents.some((agent) => agent.agentId === 'child-1'), false);
});

test('subagents time out without sleeping or entering the box', () => {
  const state = new AgentState({
    activeTimeoutSec: 60,
    staleTimeoutSec: 300,
    boxSubagentsImmediately: false
  });

  state.applyEvent({
    type: EVENT_TYPES.SUBAGENT_SPAWN,
    agentId: 'child-1',
    ts: 1,
    meta: {
      parentId: 'parent-1',
      projectId: 'project-a',
      sessionId: 'session-a'
    }
  });

  state.tick(61001);

  assert.equal(state.agents.has('child-1'), false);
  assert.equal(state.boxedAgents.some((agent) => agent.agentId === 'child-1'), false);
});

test('immediate subagent cleanup does not add them to the box', () => {
  const state = new AgentState({
    boxSubagentsImmediately: true
  });

  state.applyEvent({
    type: EVENT_TYPES.SUBAGENT_SPAWN,
    agentId: 'child-1',
    ts: 1,
    meta: {
      parentId: 'parent-1',
      projectId: 'project-a',
      sessionId: 'session-a'
    }
  });

  state.tick(2);

  assert.equal(state.agents.has('child-1'), false);
  assert.equal(state.boxedAgents.some((agent) => agent.agentId === 'child-1'), false);
});

test('boxed agent history keeps only the newest configured entries', () => {
  const state = new AgentState({
    maxBoxedAgents: 2
  });

  for (let i = 1; i <= 3; i += 1) {
    state.applyEvent({
      type: EVENT_TYPES.AGENT_SEEN,
      agentId: 'agent-' + i,
      ts: i,
      meta: {
        projectId: 'project-a',
        sessionId: 'session-a'
      }
    });
    state.applyEvent({
      type: EVENT_TYPES.AGENT_DONE,
      agentId: 'agent-' + i,
      ts: i + 100,
      meta: {}
    });
  }

  assert.equal(state.boxedAgents.length, 2);
  assert.deepEqual(state.boxedAgents.map((agent) => agent.agentId), ['agent-2', 'agent-3']);
});

test('state restore trims oversized boxed and subagent history buffers', () => {
  const state = new AgentState({
    maxBoxedAgents: 2,
    maxSubagentHistory: 2
  });

  const restored = state.restore({
    version: 1,
    agents: [],
    boxedAgents: [
      { agentId: 'boxed-1', counters: {} },
      { agentId: 'boxed-2', counters: {} },
      { agentId: 'boxed-3', counters: {} }
    ],
    subagentHistory: [
      { agentId: 'child-1', parentId: 'parent-1', createdAt: 1, doneAt: 2, counters: {} },
      { agentId: 'child-2', parentId: 'parent-2', createdAt: 3, doneAt: 4, counters: {} },
      { agentId: 'child-3', parentId: 'parent-3', createdAt: 5, doneAt: 6, counters: {} }
    ]
  });

  assert.equal(restored, true);
  assert.deepEqual(state.boxedAgents.map((agent) => agent.agentId), ['boxed-2', 'boxed-3']);
  assert.deepEqual(state.subagentHistory.map((agent) => agent.agentId), ['child-2', 'child-3']);
});

test('mock driver seeds initial root agents with visible last commands', () => {
  const { createMockDriver } = require('../cli');
  const state = new AgentState({
    boxSubagentsImmediately: false
  });
  const mock = createMockDriver(state);

  mock.start();
  const snapshot = state.snapshot();
  mock.stop();

  assert.ok(snapshot.agents.length > 0);
  assert.ok(snapshot.agents.some((agent) => typeof agent.lastCommand === 'string' && agent.lastCommand.length > 0));
});

test('mock driver lets some root agents fall asleep after inactivity', async () => {
  const { createMockDriver } = require('../cli');
  const state = new AgentState({
    activeTimeoutSec: 1,
    staleTimeoutSec: 20,
    boxSubagentsImmediately: false
  });
  const mock = createMockDriver(state);

  mock.start();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  state.tick(Date.now());
  const snapshot = state.snapshot();
  mock.stop();

  assert.ok(snapshot.agents.some((agent) => !agent.parentId && agent.isSleeping));
});

test('watcher preserves multibyte utf8 across incremental reads', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-'));
  const filePath = path.join(tempRoot, 'session.jsonl');
  fs.writeFileSync(filePath, '');

  const watcher = new TranscriptWatcher({ rootPath: tempRoot });
  const events = [];
  watcher.on('event', (event) => events.push(event));

  const state = {
    position: 0,
    leftover: '',
    decoder: new StringDecoder('utf8'),
    reading: false,
    pending: false
  };
  watcher.fileStates.set(filePath, state);

  const prefix = Buffer.from('{"role":"assistant","text":"');
  const splitChar = Buffer.from('한', 'utf8');
  const suffix = Buffer.from('"}\n');

  fs.appendFileSync(filePath, Buffer.concat([prefix, splitChar.subarray(0, 1)]));
  await watcher.readNewBytes(filePath, state, false);
  assert.equal(events.length, 0);

  fs.appendFileSync(filePath, Buffer.concat([splitChar.subarray(1), suffix]));
  await watcher.readNewBytes(filePath, state, false);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, EVENT_TYPES.AGENT_SEEN);
  assert.equal(events[1].type, EVENT_TYPES.ASSISTANT_OUTPUT);
});

run();
