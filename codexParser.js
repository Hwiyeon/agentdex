'use strict';

const path = require('path');
const { EVENT_TYPES } = require('./parser');

const MAX_SUMMARY_LEN = 48;

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function pick(entry, paths) {
  for (const rawPath of paths) {
    const parts = rawPath.split('.');
    let cursor = entry;
    let found = true;
    for (const part of parts) {
      if (cursor && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, part)) {
        cursor = cursor[part];
      } else {
        found = false;
        break;
      }
    }
    if (found && cursor !== undefined && cursor !== null) {
      return cursor;
    }
  }
  return undefined;
}

function toMs(tsLike) {
  if (typeof tsLike === 'number' && Number.isFinite(tsLike)) {
    return tsLike < 1e12 ? Math.floor(tsLike * 1000) : Math.floor(tsLike);
  }
  if (typeof tsLike === 'string') {
    if (/^\d+$/.test(tsLike)) {
      const num = Number(tsLike);
      if (Number.isFinite(num)) {
        return num < 1e12 ? Math.floor(num * 1000) : Math.floor(num);
      }
    }
    const parsed = Date.parse(tsLike);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function normalizeInlineText(value) {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    return normalizeInlineText(value.map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return String(item);
      if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
      return '';
    }).join(' '));
  }
  return null;
}

function summarizeText(value) {
  let text = normalizeInlineText(value);
  if (!text) return null;
  text = text.replace(/@\S+/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > MAX_SUMMARY_LEN) {
    const cut = text.lastIndexOf(' ', MAX_SUMMARY_LEN);
    text = `${text.slice(0, cut > 0 ? cut : MAX_SUMMARY_LEN)}...`;
  }
  return text;
}

function humanProjectName(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return null;
  }
  const base = path.basename(cwd.replace(/[\\\/]+$/, ''));
  return base || cwd;
}

function deriveContextFromPath(filePath, configuredRoot) {
  const normalized = path.resolve(filePath);
  const root = configuredRoot ? path.resolve(configuredRoot) : '';
  const fileName = path.basename(normalized, '.jsonl');
  let projectId = 'codex';

  if (root && normalized.startsWith(root)) {
    const rel = path.relative(root, normalized);
    const parts = rel.split(path.sep).filter(Boolean);
    if (parts.length >= 4) {
      projectId = `codex-${parts[0]}-${parts[1]}-${parts[2]}`;
    }
  }

  return {
    projectId,
    sessionId: `codex:${fileName || 'unknown-session'}`
  };
}

function parseArguments(raw) {
  if (!raw || typeof raw !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function extractLastCommand(toolName, args) {
  const direct = normalizeInlineText(pick(args, [
    'cmd',
    'command',
    'command_line',
    'commandLine',
    'input.cmd',
    'input.command'
  ]));
  if (direct) return direct;

  const name = String(toolName || '').toLowerCase();
  if (name === 'shell_command' || name === 'exec_command') {
    return normalizeInlineText(args.input) || normalizeInlineText(args.arguments) || null;
  }
  return null;
}

function normalizeRateLimits(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const primary = raw.primary || null;
  const secondary = raw.secondary || null;
  const out = {};

  if (primary && typeof primary.used_percent === 'number') {
    out.five_hour = {
      used_percentage: primary.used_percent,
      resets_at: primary.resets_at || null
    };
  }

  if (secondary && typeof secondary.used_percent === 'number') {
    out.seven_day = {
      used_percentage: secondary.used_percent,
      resets_at: secondary.resets_at || null
    };
  }

  return Object.keys(out).length > 0 ? out : null;
}

function baseMetaFor(entry, context) {
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const pathContext = deriveContextFromPath(context.filePath, context.configuredRoot);
  const cwd = pick(payload, ['cwd']);
  const projectId = humanProjectName(cwd) || pathContext.projectId;
  const model = pick(payload, ['model']) || pick(entry, ['payload.model']);

  const meta = {
    provider: 'codex',
    projectId,
    sessionId: pathContext.sessionId,
    filePath: context.filePath
  };

  if (typeof cwd === 'string' && cwd) {
    meta.cwd = cwd;
  }
  if (typeof model === 'string' && model) {
    meta.model = model;
  }
  return meta;
}

function pushSeen(events, agentId, ts, meta) {
  events.push({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId,
    ts,
    meta
  });
}

function normalizeCodexEntry(entry, context) {
  const ts = toMs(pick(entry, ['timestamp', 'ts', 'time', 'payload.started_at']));
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const payloadType = String(payload.type || '').toLowerCase();
  const entryType = String(entry.type || '').toLowerCase();
  const meta = baseMetaFor(entry, context);
  const agentId = `${meta.sessionId}:main`;
  const events = [];

  if (payloadType === 'task_started' && typeof payload.model_context_window === 'number') {
    meta.contextMax = payload.model_context_window;
  }

  if (entryType === 'turn_context') {
    if (typeof payload.model === 'string') {
      meta.model = payload.model;
    }
    if (typeof payload.model_context_window === 'number') {
      meta.contextMax = payload.model_context_window;
    }
  }

  if (entryType === 'session_meta') {
    if (typeof payload.model_provider === 'string') {
      meta.modelProvider = payload.model_provider;
    }
  }

  pushSeen(events, agentId, ts, meta);

  if (payloadType === 'user_message') {
    const summary = summarizeText(payload.message || payload.text_elements);
    if (summary) {
      meta.sessionDisplayName = summary;
      meta.lastUserQuery = summary;
    }
    events.push({
      type: EVENT_TYPES.USER_QUERY,
      agentId,
      ts,
      meta
    });
    return events;
  }

  if (payloadType === 'token_count') {
    const info = payload.info || {};
    const totalUsage = info.total_token_usage || {};
    const lastUsage = info.last_token_usage || {};
    const contextUsed = Number(totalUsage.input_tokens);
    const totalTokens = Number(lastUsage.total_tokens);
    const contextMax = Number(info.model_context_window);
    const rateLimits = normalizeRateLimits(payload.rate_limits);
    const outputMeta = { ...meta };

    if (Number.isFinite(contextUsed) && contextUsed > 0) {
      outputMeta.contextUsed = contextUsed;
    }
    if (Number.isFinite(totalTokens) && totalTokens > 0) {
      outputMeta.totalTokens = totalTokens;
    }
    if (Number.isFinite(contextMax) && contextMax > 0) {
      outputMeta.contextMax = contextMax;
    }
    if (rateLimits) {
      outputMeta.rateLimits = rateLimits;
    }

    events.push({
      type: EVENT_TYPES.ASSISTANT_OUTPUT,
      agentId,
      ts,
      meta: outputMeta
    });
    return events;
  }

  if (entryType === 'response_item' && (payloadType === 'function_call' || payloadType === 'custom_tool_call')) {
    const toolName = String(payload.name || 'unknown_tool');
    const args = parseArguments(payload.arguments);
    const toolMeta = {
      ...meta,
      toolName
    };
    const lastCommand = extractLastCommand(toolName, args);
    if (lastCommand) {
      toolMeta.lastCommand = lastCommand;
    }
    if (toolName === 'spawn_agent') {
      const description = summarizeText(args.message);
      if (description) {
        toolMeta.agentDescription = description;
      }
      if (args.agent_type) {
        toolMeta.subagentType = String(args.agent_type);
      }
    }

    events.push({
      type: EVENT_TYPES.TOOL_START,
      agentId,
      ts,
      meta: toolMeta
    });
    return events;
  }

  if (entryType === 'response_item' && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) {
    events.push({
      type: EVENT_TYPES.TOOL_END,
      agentId,
      ts,
      meta: {
        ...meta,
        toolName: 'unknown_tool'
      }
    });
    return events;
  }

  if (
    payloadType === 'agent_message' ||
    (entryType === 'response_item' && (payloadType === 'message' || payloadType === 'reasoning'))
  ) {
    events.push({
      type: EVENT_TYPES.ASSISTANT_OUTPUT,
      agentId,
      ts,
      meta
    });
    return events;
  }

  if (payloadType === 'task_complete' || payloadType === 'turn_aborted') {
    events.push({
      type: EVENT_TYPES.AGENT_DONE,
      agentId,
      ts,
      meta
    });
    return events;
  }

  return events;
}

function normalizeCodexLine(line, context = {}) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  return normalizeCodexEntry(parsed, context);
}

module.exports = {
  normalizeCodexLine
};
