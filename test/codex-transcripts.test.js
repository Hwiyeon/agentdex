'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { test, run } = require('./runner');
const { EVENT_TYPES } = require('../parser');
const { normalizeCodexLine } = require('../codexParser');
const { TranscriptWatcher } = require('../watcher');
const { AgentState } = require('../state');
const { getPersistencePaths, resolveConfig } = require('../cli');

function contextFor(filePath, configuredRoot) {
  return { filePath, configuredRoot, provider: 'codex' };
}

test('Codex user messages and token counts normalize into agent events', () => {
  const transcriptPath = '/tmp/codex/sessions/2026/05/17/rollout-abc.jsonl';
  const rootPath = '/tmp/codex/sessions';

  const userEvents = normalizeCodexLine(
    JSON.stringify({
      timestamp: '2026-05-16T15:09:28.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Make a Codex version of this dashboard'
      }
    }),
    contextFor(transcriptPath, rootPath)
  );

  assert.deepEqual(userEvents.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.USER_QUERY]);
  assert.equal(userEvents[0].agentId, 'codex:rollout-abc:main');
  assert.equal(userEvents[0].meta.provider, 'codex');
  assert.equal(userEvents[0].meta.projectId, 'codex-2026-05-17');
  assert.equal(userEvents[1].meta.lastUserQuery, 'Make a Codex version of this dashboard');

  const tokenEvents = normalizeCodexLine(
    JSON.stringify({
      timestamp: '2026-05-16T15:09:39.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 26603,
            output_tokens: 437,
            total_tokens: 27040
          },
          last_token_usage: {
            total_tokens: 27040
          },
          model_context_window: 258400
        },
        rate_limits: {
          primary: { used_percent: 7, resets_at: 1778954623 },
          secondary: { used_percent: 1, resets_at: 1779541423 }
        }
      }
    }),
    contextFor(transcriptPath, rootPath)
  );

  assert.deepEqual(tokenEvents.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.ASSISTANT_OUTPUT]);
  assert.equal(tokenEvents[1].meta.contextUsed, 26603);
  assert.equal(tokenEvents[1].meta.contextMax, 258400);
  assert.equal(tokenEvents[1].meta.totalTokens, 27040);
  assert.equal(tokenEvents[1].meta.rateLimits.five_hour.used_percentage, 7);
});

test('Codex tool calls capture command text', () => {
  const events = normalizeCodexLine(
    JSON.stringify({
      timestamp: '2026-05-16T15:09:30.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: 'npm test',
          workdir: 'C:/repo'
        }),
        call_id: 'call_123'
      }
    }),
    contextFor('/tmp/codex/sessions/2026/05/17/rollout-abc.jsonl', '/tmp/codex/sessions')
  );

  assert.deepEqual(events.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.TOOL_START]);
  assert.equal(events[1].meta.toolName, 'exec_command');
  assert.equal(events[1].meta.lastCommand, 'npm test');
});

test('Codex watcher and state process a transcript stream end to end', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-codex-'));
  const sessionDir = path.join(rootDir, '2026', '05', '17');
  const transcriptPath = path.join(sessionDir, 'rollout-abc.jsonl');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(transcriptPath, '');

  const watcher = new TranscriptWatcher({
    provider: 'codex',
    label: 'Codex',
    rootPath: rootDir,
    normalizeLine: normalizeCodexLine
  });
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
      timestamp: '2026-05-16T15:09:27.000Z',
      type: 'turn_context',
      payload: {
        cwd: 'C:/Users/Hwing/Documents/Projects/poke-agent-safari',
        model: 'gpt-5.5',
        model_context_window: 258400
      }
    },
    {
      timestamp: '2026-05-16T15:09:28.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Build Codex support'
      }
    },
    {
      timestamp: '2026-05-16T15:09:29.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'rg --files' }),
        call_id: 'call_1'
      }
    },
    {
      timestamp: '2026-05-16T15:09:30.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'ok'
      }
    },
    {
      timestamp: '2026-05-16T15:09:31.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1000, total_tokens: 1200 },
          last_token_usage: { total_tokens: 1200 },
          model_context_window: 258400
        },
        rate_limits: {
          primary: { used_percent: 5, resets_at: 1778954623 },
          secondary: { used_percent: 2, resets_at: 1779541423 }
        }
      }
    }
  ];

  fs.appendFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  await watcher.readNewBytes(transcriptPath, fileState, false);

  const agent = state.agents.get('codex:rollout-abc:main');
  assert.ok(agent);
  assert.equal(agent.provider, 'codex');
  assert.equal(agent.projectId, 'poke-agent-safari');
  assert.equal(agent.model, 'gpt-5.5');
  assert.equal(agent.lastUserQuery, 'Build Codex support');
  assert.equal(agent.lastCommand, 'rg --files');
  assert.equal(agent.contextUsed, 1000);
  assert.equal(agent.contextMax, 258400);
  assert.equal(agent.totalTokens, 1200);
  assert.equal(state.snapshot().rateLimits.five_hour.used_percentage, 5);
});

test('Codex source config and persistence are separate from Claude watch state', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-codex-persist-'));
  const claudePaths = getPersistencePaths('watch', tempRoot, 'claude');
  const codexPaths = getPersistencePaths('watch', tempRoot, 'codex');
  const { config } = resolveConfig(['watch', '--source', 'codex', '--codex-path', '/tmp/codex-sessions']);

  assert.equal(config.source, 'codex');
  assert.equal(config.codexSessionsPath, path.resolve('/tmp/codex-sessions'));
  assert.notEqual(claudePaths.baseDir, codexPaths.baseDir);
  assert.equal(codexPaths.stateFile, path.join(tempRoot, 'data', 'runtime', 'codex', 'state.json'));
});

run();
