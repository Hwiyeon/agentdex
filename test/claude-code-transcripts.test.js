'use strict';

const { test, run } = require('./runner');
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const { EVENT_TYPES, normalizeLine } = require('../parser');
const { AgentState } = require('../state');
const { TranscriptWatcher } = require('../watcher');

function contextFor(filePath, configuredRoot) {
  return { filePath, configuredRoot };
}

test('Claude Code assistant tool-use messages are normalized from transcript paths', () => {
  const events = normalizeLine(
    JSON.stringify({
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 1200,
          output_tokens: 320,
          cache_read_input_tokens: 200
        },
        content: [
          { type: 'tool_use', name: 'Read' }
        ]
      }
    }),
    contextFor('/tmp/claude/projects/demo-project/session-123.jsonl', '/tmp/claude/projects')
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.TOOL_START, EVENT_TYPES.ASSISTANT_OUTPUT]
  );
  assert.equal(events[0].agentId, 'session-123:main');
  assert.equal(events[0].meta.projectId, 'demo-project');
  assert.equal(events[0].meta.sessionId, 'session-123');
  assert.equal(events[1].meta.toolName, 'Read');
  assert.equal(events[2].meta.contextUsed, 1400);
  assert.equal(events[2].meta.totalTokens, 1720);
});

test('Claude Code bash tool-use messages capture the last command', () => {
  const events = normalizeLine(
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'bash', input: { cmd: 'npm test -- --watch=false' } }
        ]
      }
    }),
    contextFor('/tmp/claude/projects/demo-project/session-123.jsonl', '/tmp/claude/projects')
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.TOOL_START, EVENT_TYPES.ASSISTANT_OUTPUT]
  );
  assert.equal(events[1].meta.toolName, 'bash');
  assert.equal(events[1].meta.lastCommand, 'npm test -- --watch=false');
});

test('Claude Code tool results and pause_turn entries normalize correctly', () => {
  const transcriptContext = contextFor('/tmp/claude/projects/demo-project/session-123.jsonl', '/tmp/claude/projects');

  const toolEvents = normalizeLine(
    JSON.stringify({
      type: 'tool_result',
      name: 'Read',
      agent_id: 'main-agent'
    }),
    transcriptContext
  );
  assert.deepEqual(toolEvents.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.TOOL_END]);
  assert.equal(toolEvents[1].meta.toolName, 'Read');

  const waitEvents = normalizeLine(
    JSON.stringify({
      agent_id: 'main-agent',
      stop_reason: 'pause_turn'
    }),
    transcriptContext
  );
  assert.deepEqual(waitEvents.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.WAITING]);
});

test('Claude Code subagent spawn entries preserve child and parent ids', () => {
  const events = normalizeLine(
    JSON.stringify({
      event: 'subagent_spawn',
      parent_id: 'session-123:main',
      child_agent_id: 'worker-1'
    }),
    contextFor('/tmp/claude/projects/demo-project/session-123.jsonl', '/tmp/claude/projects')
  );

  assert.deepEqual(events.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.SUBAGENT_SPAWN]);
  assert.equal(events[0].agentId, 'worker-1');
  assert.equal(events[1].agentId, 'worker-1');
  assert.equal(events[1].meta.parentId, 'session-123:main');
});

test('watcher and state process a Claude Code style transcript stream end to end', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-claude-'));
  const projectDir = path.join(rootDir, 'demo-project');
  const transcriptPath = path.join(projectDir, 'session-123.jsonl');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcriptPath, '');

  const watcher = new TranscriptWatcher({ rootPath: rootDir });
  const state = new AgentState();
  watcher.on('event', (event) => state.applyEvent(event));

  const fileState = {
    position: 0,
    leftover: '',
    decoder: new StringDecoder('utf8'),
    reading: false,
    pending: false
  };
  watcher.fileStates.set(transcriptPath, fileState);

  const lines = [
    {
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 100
        },
        content: [
          { type: 'tool_use', name: 'Read' }
        ]
      }
    },
    {
      type: 'tool_result',
      name: 'Read',
      agent_id: 'session-123:main'
    },
    {
      event: 'subagent_spawn',
      parent_id: 'session-123:main',
      child_agent_id: 'worker-1'
    },
    {
      agent_id: 'worker-1',
      role: 'assistant',
      text: 'done',
      usage: {
        input_tokens: 300,
        output_tokens: 50
      },
      stop_reason: 'pause_turn'
    }
  ];

  fs.appendFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  await watcher.readNewBytes(transcriptPath, fileState, false);

  const mainAgent = state.agents.get('session-123:main');
  const childAgent = state.agents.get('worker-1');

  assert.ok(mainAgent);
  assert.ok(childAgent);
  assert.equal(mainAgent.projectId, 'demo-project');
  assert.equal(mainAgent.sessionId, 'session-123');
  assert.equal(mainAgent.counters.toolStarts, 1);
  assert.equal(mainAgent.counters.toolEnds, 1);
  assert.equal(mainAgent.lastTool, 'Read');
  assert.equal(mainAgent.selfTokens, 1300);
  assert.equal(mainAgent.totalTokens, 1650);
  assert.equal(childAgent.parentId, 'session-123:main');
  assert.equal(childAgent.projectId, 'demo-project');
  assert.equal(childAgent.sessionId, 'session-123');
  assert.equal(childAgent.status, 'Waiting');
  assert.equal(childAgent.counters.waits, 1);
  assert.equal(childAgent.selfTokens, 350);
  assert.equal(childAgent.totalTokens, 350);
});

test('watcher hard reset re-primes to EOF without replaying prior transcript lines', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-watch-reset-'));
  const projectDir = path.join(rootDir, 'demo-project');
  const transcriptPath = path.join(projectDir, 'session-123.jsonl');
  fs.mkdirSync(projectDir, { recursive: true });

  const firstLine = JSON.stringify({
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 100,
        output_tokens: 20
      },
      content: [
        { type: 'text', text: 'first output' }
      ]
    }
  });
  fs.writeFileSync(transcriptPath, `${firstLine}\n`);

  const watcher = new TranscriptWatcher({ rootPath: rootDir });
  const seenEvents = [];
  watcher.on('event', (event) => seenEvents.push(event));

  await watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const initialEventCount = seenEvents.length;
  assert.equal(initialEventCount, 2);

  await watcher.resetToCurrentEnd();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(seenEvents.length, initialEventCount);

  const secondLine = JSON.stringify({
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 200,
        output_tokens: 30
      },
      content: [
        { type: 'text', text: 'second output' }
      ]
    }
  });
  fs.appendFileSync(transcriptPath, `${secondLine}\n`);
  await watcher.tailFile(transcriptPath);

  assert.equal(seenEvents.length, initialEventCount + 2);
  assert.equal(seenEvents[seenEvents.length - 1].meta.totalTokens, 230);

  await watcher.stop();
});

test('last command survives into boxed agent history', () => {
  const state = new AgentState();

  state.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'session-123:main',
    ts: 1,
    meta: { projectId: 'demo-project', sessionId: 'session-123' }
  });
  state.applyEvent({
    type: EVENT_TYPES.TOOL_START,
    agentId: 'session-123:main',
    ts: 2,
    meta: {
      projectId: 'demo-project',
      sessionId: 'session-123',
      toolName: 'bash',
      lastCommand: 'npm test'
    }
  });

  const liveSnapshot = state.snapshot();
  assert.equal(liveSnapshot.agents[0].lastCommand, 'npm test');

  state.applyEvent({
    type: EVENT_TYPES.AGENT_DONE,
    agentId: 'session-123:main',
    ts: 3,
    meta: {}
  });

  assert.equal(state.boxedAgents.length, 1);
  assert.equal(state.boxedAgents[0].lastCommand, 'npm test');
});

run();
