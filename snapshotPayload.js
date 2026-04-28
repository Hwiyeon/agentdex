'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function readRateLimits(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  try {
    const metaPath = path.join(homeDir, '.claude', 'context_meta', '_rate_limits.json');
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!data.rate_limits) return null;
    // Surface the writer timestamp so the UI can detect stale data when statusline
    // hasn't fired (e.g. VSCode-only sessions, where statusline-command.sh never runs).
    const tsSec = Number(data.ts);
    return {
      ...data.rate_limits,
      writtenAtMs: Number.isFinite(tsSec) ? Math.floor(tsSec * 1000) : null
    };
  } catch (_) {
    return null;
  }
}

function buildPublicSnapshot(state, publicConfig = {}, options = {}) {
  const config = {
    mode: publicConfig.mode || (publicConfig.isMockMode ? 'mock' : 'watch'),
    enablePokeapiSprites: !!publicConfig.enablePokeapiSprites,
    isMockMode: !!publicConfig.isMockMode,
    supportsHardReset: !!publicConfig.supportsHardReset
  };

  return {
    ...state.snapshot(),
    rateLimits: options.rateLimits === undefined ? readRateLimits(options) : options.rateLimits,
    config
  };
}

module.exports = {
  readRateLimits,
  buildPublicSnapshot
};
