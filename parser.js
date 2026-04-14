'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EVENT_TYPES = Object.freeze({
  AGENT_SEEN: 'AGENT_SEEN',
  TOOL_START: 'TOOL_START',
  TOOL_END: 'TOOL_END',
  ASSISTANT_OUTPUT: 'ASSISTANT_OUTPUT',
  WAITING: 'WAITING',
  SUBAGENT_SPAWN: 'SUBAGENT_SPAWN',
  AGENT_DONE: 'AGENT_DONE',
  USER_QUERY: 'USER_QUERY'
});

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
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

function stableFallbackId(filePath, sessionId, projectId) {
  const base = `${filePath}|${sessionId || ''}|${projectId || ''}`;
  const digest = crypto.createHash('sha1').update(base).digest('hex').slice(0, 10);
  return `agent-${digest}`;
}

function deriveContextFromPath(filePath, configuredRoot) {
  const normalized = path.resolve(filePath);
  const root = configuredRoot ? path.resolve(configuredRoot) : '';
  if (!root || !normalized.startsWith(root)) {
    return { projectId: null, sessionId: null, parentSessionId: null };
  }

  const rel = path.relative(root, normalized);
  const parts = rel.split(path.sep).filter(Boolean);
  const projectId = parts.length > 0 ? parts[0] : null;
  const fileName = parts.length > 0 ? parts[parts.length - 1] : '';
  const sessionId = fileName.replace(/\.jsonl$/i, '') || null;

  // Detect subagents/ directory: {project}/{sessionId}/subagents/{agentFile}.jsonl
  let parentSessionId = null;
  const subagentsIdx = parts.indexOf('subagents');
  if (subagentsIdx > 0) {
    parentSessionId = parts[subagentsIdx - 1] || null;
  }

  return { projectId, sessionId, parentSessionId };
}

function contentBlocks(entry) {
  const direct = pick(entry, ['content']);
  if (Array.isArray(direct)) {
    return direct;
  }

  const nested = pick(entry, ['message.content', 'delta.content']);
  if (Array.isArray(nested)) {
    return nested;
  }

  return [];
}

function normalizeInlineText(value) {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    return text || null;
  }

  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      if (typeof item === 'string' || typeof item === 'number') {
        parts.push(String(item));
      }
    }
    return normalizeInlineText(parts.join(' '));
  }

  return null;
}

function isShellLikeTool(toolName) {
  const name = String(toolName || '').toLowerCase();
  return name === 'bash' || name === 'exec_command' || name === 'shell' || name === 'terminal' || name === 'command';
}

function extractLastCommand(toolName, block, entry) {
  const directCommand = normalizeInlineText(pick(block, [
    'input.cmd',
    'input.command',
    'input.command_line',
    'input.commandLine',
    'cmd',
    'command',
    'command_line',
    'commandLine'
  ])) || normalizeInlineText(pick(entry, [
    'input.cmd',
    'input.command',
    'input.command_line',
    'input.commandLine',
    'arguments.cmd',
    'arguments.command',
    'args.cmd',
    'args.command',
    'params.cmd',
    'params.command',
    'cmd',
    'command',
    'command_line',
    'commandLine'
  ]));

  if (directCommand) {
    return directCommand;
  }

  const argv = pick(block, ['input.argv', 'argv']) || pick(entry, ['input.argv', 'argv', 'args.argv']);
  const argvCommand = normalizeInlineText(argv);
  if (argvCommand) {
    return argvCommand;
  }

  if (!isShellLikeTool(toolName)) {
    return null;
  }

  const inlineInput = normalizeInlineText(pick(block, ['input'])) || normalizeInlineText(pick(entry, ['input']));
  return inlineInput || null;
}

function hasAssistantOutput(entry, blocks) {
  const role = String(pick(entry, ['role', 'message.role', 'delta.role']) || '').toLowerCase();
  const type = String(pick(entry, ['type', 'event']) || '').toLowerCase();

  if (role === 'assistant') {
    return true;
  }

  if (type.includes('assistant') && (type.includes('message') || type.includes('delta') || type.includes('output'))) {
    return true;
  }

  if (typeof pick(entry, ['text', 'delta.text']) === 'string' && role !== 'user') {
    return true;
  }

  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const blockType = String(block.type || '').toLowerCase();
    if (blockType === 'text' || blockType === 'output_text' || blockType === 'assistant_text') {
      return true;
    }
  }

  return false;
}

function explicitSpawnInfo(entry) {
  const eventName = String(pick(entry, ['event', 'type', 'name', 'action']) || '').toLowerCase();
  const isSpawnEvent = eventName.includes('spawn') && (eventName.includes('agent') || eventName.includes('sub'));
  if (!isSpawnEvent) {
    return null;
  }

  const parentId = pick(entry, [
    'parentId',
    'parent_id',
    'meta.parentId',
    'metadata.parent_id',
    'details.parentAgentId'
  ]);
  const childId = pick(entry, [
    'childAgentId',
    'child_agent_id',
    'spawnedAgentId',
    'spawned_agent_id',
    'agentId',
    'agent_id',
    'meta.childId',
    'details.agentId'
  ]);

  if (!childId && !parentId) {
    return null;
  }

  const description = pick(entry, [
    'description',
    'meta.description',
    'details.description',
    'input.description',
    'metadata.description'
  ]);
  const subagentType = pick(entry, [
    'subagent_type',
    'subagentType',
    'meta.subagent_type',
    'details.subagentType',
    'input.subagent_type'
  ]);

  return {
    parentId: parentId ? String(parentId) : undefined,
    childId: childId ? String(childId) : undefined,
    description: description ? String(description) : undefined,
    subagentType: subagentType ? String(subagentType) : undefined
  };
}

const MAX_SUMMARY_LEN = 48;

// Auto-generated content patterns injected by IDE/CLI before the real user input.
const AUTO_CONTENT_RE = /^<(?:ide_opened_file|command-message|command-name|command-args|local-command-caveat|system-reminder)\b/;
// Internal metadata text blocks: short random IDs, tool_use IDs, /tmp paths.
const INTERNAL_META_RE = /^[a-z0-9]{6,12}\n?toolu_|^toolu_|^\/tmp\/claude/;

function summarizeUserMessage(entry) {
  const role = String(pick(entry, ['role', 'message.role']) || '').toLowerCase();
  if (role !== 'user') return null;

  const content = pick(entry, ['message.content', 'content']);
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // Skip auto-generated blocks (IDE file open notices, command wrappers, etc.)
    // and pick the first block that contains actual user-typed text.
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        const trimmed = block.text.trim();
        if (trimmed && !AUTO_CONTENT_RE.test(trimmed) && !INTERNAL_META_RE.test(trimmed)) {
          text = trimmed;
          break;
        }
      }
    }
    // Fallback: if all blocks were auto-generated, use the first text block.
    if (!text) {
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          text = block.text;
          break;
        }
      }
    }
  }
  if (!text) return null;

  // Reject internal metadata that leaked into user text blocks
  if (INTERNAL_META_RE.test(text.trim())) return null;

  // Strip @path/to/file mentions, XML/HTML tags, and clean up whitespace
  text = text.replace(/@\S+/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // Truncate at word boundary
  if (text.length > MAX_SUMMARY_LEN) {
    const cut = text.lastIndexOf(' ', MAX_SUMMARY_LEN);
    text = text.slice(0, cut > 0 ? cut : MAX_SUMMARY_LEN) + '…';
  }
  return text;
}

function humanProjectName(projectId) {
  if (!projectId) return null;
  // projectId from path is like "-home-hwing-Projects-poke-agents"
  // Split into real path segments and find the project name after common parent dirs
  const segments = projectId.replace(/^-+/, '').split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).join('-').split('-').filter(Boolean);
  const skipSet = new Set(['home', 'users', 'user', 'projects', 'repos', 'src', 'code', 'work', 'workspace', 'documents', 'desktop']);
  // Walk segments; once we pass all skip-dirs, the rest is the project name
  let lastSkipIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (skipSet.has(segments[i].toLowerCase())) {
      lastSkipIdx = i;
    }
  }
  const meaningful = segments.slice(lastSkipIdx + 1);
  if (meaningful.length > 0) return meaningful.join('-');
  return segments[segments.length - 1] || projectId;
}

// Whether extended context (1M) is enabled, read from ~/.claude/settings.json
let _extendedContext = false;

function setExtendedContext(enabled) {
  _extendedContext = !!enabled;
}

function modelContextMax(model) {
  const m = String(model).toLowerCase();
  // Haiku is always 200K
  if (m.includes('haiku')) return 200000;
  // Opus / Sonnet: 1M if extended context enabled, else 200K
  if (_extendedContext && (m.includes('opus') || m.includes('sonnet'))) return 1000000;
  return 200000;
}

// Read context_window_size from statusline-exported metadata (authoritative source).
// Files written by ~/.claude/statusline-command.sh at ~/.claude/context_meta/{sessionId}.json
const _contextMetaCache = new Map();   // sessionId -> { value, readAt }
const CONTEXT_META_TTL_MS = 10_000;

function readSessionContextMax(sessionId) {
  if (!sessionId) return null;
  const now = Date.now();
  const cached = _contextMetaCache.get(sessionId);
  if (cached && now - cached.readAt < CONTEXT_META_TTL_MS) return cached.value;
  try {
    const metaPath = path.join(os.homedir(), '.claude', 'context_meta', `${sessionId}.json`);
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const size = Number(data.context_window_size);
    if (size > 0) {
      _contextMetaCache.set(sessionId, { value: size, readAt: now });
      return size;
    }
  } catch (_) { /* file not yet written — fall through */ }
  _contextMetaCache.set(sessionId, { value: null, readAt: now });
  return null;
}

function normalizeEntry(entry, context) {
  const ts = toMs(
    pick(entry, ['ts', 'timestamp', 'time', 'created_at', 'createdAt', 'meta.ts', 'metadata.timestamp'])
  );

  const projectId = String(
    pick(entry, ['projectId', 'project_id', 'project', 'metadata.projectId', 'meta.project_id']) ||
      context.projectId ||
      'unknown-project'
  );

  const sessionId = String(
    pick(entry, ['sessionId', 'session_id', 'conversation_id', 'thread_id', 'metadata.sessionId']) ||
      context.sessionId ||
      path.basename(context.filePath, '.jsonl') ||
      'unknown-session'
  );

  const parentIdValue = pick(entry, [
    'parentId',
    'parent_id',
    'metadata.parentId',
    'meta.parent_id',
    'context.parentAgentId'
  ]);

  const explicitAgentId = pick(entry, [
    'agentId',
    'agent_id',
    'assistant_id',
    'metadata.agentId',
    'meta.agent_id',
    'source.agentId',
    'message.agent_id'
  ]);

  const parentId = parentIdValue
    ? String(parentIdValue)
    : context.parentSessionId
      ? `${context.parentSessionId}:main`
      : undefined;
  const spawn = explicitSpawnInfo(entry);
  const fallbackAgentId =
    sessionId && sessionId !== 'unknown-session'
      ? `${sessionId}:main`
      : stableFallbackId(context.filePath, sessionId, projectId);
  const agentId = explicitAgentId
    ? String(explicitAgentId)
    : spawn && spawn.childId
      ? spawn.childId
      : fallbackAgentId;

  const baseMeta = {
    projectId,
    sessionId,
    parentId,
    filePath: context.filePath
  };

  // Carry forward agent metadata from .meta.json (read by watcher)
  if (context.agentMeta) {
    if (context.agentMeta.description) baseMeta.agentDescription = context.agentMeta.description;
    if (context.agentMeta.agentType) baseMeta.subagentType = context.agentMeta.agentType;
  }

  // Extract session display name from first user message (user query only, no project prefix).
  const userSummary = summarizeUserMessage(entry);
  if (userSummary) {
    baseMeta.sessionDisplayName = userSummary;
    baseMeta.lastUserQuery = userSummary;
  }

  const events = [];
  const seenEvent = {
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: agentId || stableFallbackId(context.filePath, sessionId, projectId),
    ts,
    meta: baseMeta
  };
  events.push(seenEvent);

  if (userSummary) {
    events.push({
      type: EVENT_TYPES.USER_QUERY,
      agentId: agentId || stableFallbackId(context.filePath, sessionId, projectId),
      ts,
      meta: baseMeta
    });
  }

  const blocks = contentBlocks(entry);

  const toolUseBlocks = blocks.filter((block) => block && String(block.type || '').toLowerCase() === 'tool_use');
  const toolResultBlocks = blocks.filter((block) => block && String(block.type || '').toLowerCase() === 'tool_result');

  const rawType = String(pick(entry, ['type', 'event']) || '').toLowerCase();

  if (rawType === 'tool_use') {
    toolUseBlocks.push(entry);
  }
  if (rawType === 'tool_result') {
    toolResultBlocks.push(entry);
  }

  for (const block of toolUseBlocks) {
    const toolName = String(block.name || pick(entry, ['tool', 'toolName', 'name']) || 'unknown_tool');
    const toolMeta = {
      ...baseMeta,
      toolName
    };
    const lastCommand = extractLastCommand(toolName, block, entry);
    if (lastCommand) {
      toolMeta.lastCommand = lastCommand;
    }

    // Extract display info from Agent tool calls
    if (toolName === 'Agent' || toolName === 'agent') {
      const input = block.input || {};
      if (input.description) toolMeta.agentDescription = String(input.description);
      if (input.subagent_type) toolMeta.subagentType = String(input.subagent_type);
    }

    events.push({
      type: EVENT_TYPES.TOOL_START,
      agentId,
      ts,
      meta: toolMeta
    });
  }

  for (const block of toolResultBlocks) {
    events.push({
      type: EVENT_TYPES.TOOL_END,
      agentId,
      ts,
      meta: {
        ...baseMeta,
        toolName: String(block.name || pick(entry, ['tool', 'toolName', 'name']) || 'unknown_tool')
      }
    });
  }

  if (hasAssistantOutput(entry, blocks)) {
    const outputMeta = { ...baseMeta };

    // Extract context usage from assistant message.usage
    const usage = pick(entry, ['message.usage', 'usage']);
    if (usage && typeof usage === 'object') {
      const inputTokens = Number(usage.input_tokens) || 0;
      const outputTokens = Number(usage.output_tokens) || 0;
      const cacheRead = Number(usage.cache_read_input_tokens) || 0;
      const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
      const contextUsed = inputTokens + cacheRead + cacheCreate;
      const totalTokens = inputTokens + outputTokens + cacheRead + cacheCreate;
      if (contextUsed > 0) {
        outputMeta.contextUsed = contextUsed;
      }
      if (totalTokens > 0) {
        outputMeta.totalTokens = totalTokens;
      }
    }

    // Derive context max: prefer statusline-exported value, fall back to model heuristic
    const model = pick(entry, ['message.model', 'model']);
    if (model && typeof model === 'string') {
      outputMeta.model = model;
    }
    const sessionContextMax = readSessionContextMax(baseMeta.sessionId);
    outputMeta.contextMax = sessionContextMax || modelContextMax(model || '');

    events.push({
      type: EVENT_TYPES.ASSISTANT_OUTPUT,
      agentId,
      ts,
      meta: outputMeta
    });
  }

  const waitingHint = String(
    pick(entry, ['status', 'state', 'phase', 'meta.status', 'metadata.state', 'stop_reason']) || ''
  ).toLowerCase();
  if (
    waitingHint === 'waiting' ||
    waitingHint === 'awaiting_user' ||
    waitingHint === 'awaiting_input' ||
    waitingHint === 'paused' ||
    waitingHint === 'pause_turn'
  ) {
    events.push({
      type: EVENT_TYPES.WAITING,
      agentId,
      ts,
      meta: baseMeta
    });
  }

  if (spawn) {
    const childId = spawn.childId || agentId;
    const spawnMeta = {
      ...baseMeta,
      parentId: spawn.parentId || parentId,
      childId,
      explicit: true
    };
    if (spawn.description) spawnMeta.agentDescription = spawn.description;
    if (spawn.subagentType) spawnMeta.subagentType = spawn.subagentType;
    events.push({
      type: EVENT_TYPES.SUBAGENT_SPAWN,
      agentId: childId,
      ts,
      meta: spawnMeta
    });
  }

  return events;
}

function normalizeLine(line, context) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const pathContext = deriveContextFromPath(context.filePath, context.configuredRoot);
  const mergedContext = {
    ...context,
    ...pathContext
  };

  return normalizeEntry(parsed, mergedContext);
}

module.exports = {
  EVENT_TYPES,
  normalizeLine,
  setExtendedContext
};
