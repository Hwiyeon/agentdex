'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function readRateLimits(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  try {
    const metaPath = path.join(homeDir, '.claude', 'context_meta', '_rate_limits.json');
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')).rate_limits || null;
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
