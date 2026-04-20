'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setExtendedContext, setAutoCompactRatio } = require('./parser');

function loadClaudeSettings(cwd = process.cwd(), homeDir = os.homedir()) {
  const settingsCandidates = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(homeDir, '.claude', 'settings.json')
  ];

  const loadedSettings = [];
  for (const settingsPath of settingsCandidates) {
    try {
      loadedSettings.push({
        path: settingsPath,
        data: JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      });
    } catch (_) {
      // Ignore missing or unreadable files.
    }
  }

  return loadedSettings;
}

function applyClaudeEnvironment(options = {}) {
  const cwd = options.cwd || process.cwd();
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;

  const loadedSettings = loadClaudeSettings(cwd, homeDir);

  let modelSetting = '';
  for (const { data } of loadedSettings) {
    if (typeof data.model === 'string' && data.model) {
      modelSetting = data.model;
      break;
    }
  }

  const extended = modelSetting.includes('[1m]');
  setExtendedContext(extended);
  stdout.write(`[config] claude model="${modelSetting}" extendedContext=${extended}\n`);

  let autoCompactPct = null;
  let autoCompactSource = null;
  const envOverride = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (envOverride !== undefined && envOverride !== '') {
    const value = Number(envOverride);
    if (Number.isFinite(value) && value > 0 && value <= 100) {
      autoCompactPct = value;
      autoCompactSource = 'process.env';
    }
  }

  if (autoCompactPct === null) {
    for (const { path: settingsPath, data } of loadedSettings) {
      const raw = data && data.env && data.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
      if (raw === undefined || raw === null || raw === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0 && value <= 100) {
        autoCompactPct = value;
        autoCompactSource = settingsPath;
        break;
      }
    }
  }

  if (autoCompactPct !== null) {
    setAutoCompactRatio(autoCompactPct / 100);
    stdout.write(`[config] CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${autoCompactPct} (source=${autoCompactSource})\n`);
  }

  return {
    loadedSettings,
    modelSetting,
    extendedContext: extended,
    autoCompactPct,
    autoCompactSource
  };
}

module.exports = {
  loadClaudeSettings,
  applyClaudeEnvironment
};
