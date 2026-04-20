'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  port: 8123,
  host: '127.0.0.1',
  claudeProjectsPath: path.join(os.homedir(), '.claude', 'projects'),
  activeTimeoutSec: 600,
  staleTimeoutSec: 28800,
  enablePokeapiSprites: true
};

const MOCK_TIMEOUT_DEFAULTS = {
  activeTimeoutSec: 8,
  staleTimeoutSec: 120
};

function expandHome(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return rawPath;
  }
  if (rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function parseBoolean(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null) {
    return fallback;
  }
  const value = String(rawValue).trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  return fallback;
}

function parseNumber(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgv(argv) {
  const out = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }

    if (token === '--pokeapi') {
      out.enablePokeapiSprites = true;
      continue;
    }
    if (token === '--no-pokeapi') {
      out.enablePokeapiSprites = false;
      continue;
    }

    const eqIndex = token.indexOf('=');
    let key;
    let value;

    if (eqIndex >= 0) {
      key = token.slice(2, eqIndex);
      value = token.slice(eqIndex + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = 'true';
      }
    }

    out[key] = value;
  }

  return out;
}

function loadConfigFile(filePath) {
  const resolved = path.resolve(filePath || path.join(process.cwd(), 'config.json'));
  if (!fs.existsSync(resolved)) {
    return {};
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
}

function readVscodeConfig(vscodeConfig, key) {
  if (!vscodeConfig) return undefined;
  if (typeof vscodeConfig.get === 'function') {
    return vscodeConfig.get(key);
  }
  return vscodeConfig[key];
}

function normalizeCliConfig(cli) {
  if (!cli) return {};
  if (Array.isArray(cli)) {
    const parsed = parseArgv(cli);
    return {
      command: parsed.help ? 'help' : parsed._[0] || 'watch',
      args: parsed
    };
  }
  if (cli.args) {
    return cli;
  }
  return {
    command: cli.command || 'watch',
    args: cli
  };
}

function resolveUnified(options = {}) {
  const source = options.source || 'web';
  const cli = normalizeCliConfig(options.cli);
  const command = cli.command || 'watch';
  const argMap = cli.args || {};
  const env = options.env || process.env;
  const configJsonPath = options.configJsonPath || (source === 'web' ? (argMap.config || path.join(process.cwd(), 'config.json')) : null);

  let fileConfig = {};
  if (configJsonPath) {
    try {
      fileConfig = loadConfigFile(configJsonPath);
    } catch (error) {
      throw new Error(`failed to parse config file (${path.resolve(configJsonPath)}): ${error.message}`);
    }
  }

  const vscodeLayer = {
    port: readVscodeConfig(options.vscodeConfig, 'port'),
    host: readVscodeConfig(options.vscodeConfig, 'host'),
    claudeProjectsPath: readVscodeConfig(options.vscodeConfig, 'claudeProjectsPath'),
    activeTimeoutSec: readVscodeConfig(options.vscodeConfig, 'activeTimeoutSec'),
    staleTimeoutSec: readVscodeConfig(options.vscodeConfig, 'staleTimeoutSec'),
    enablePokeapiSprites: readVscodeConfig(options.vscodeConfig, 'enablePokeapiSprites')
  };

  const envConfig = {
    port: env.PORT,
    host: env.HOST,
    claudeProjectsPath: env.CLAUDE_PROJECTS_PATH,
    activeTimeoutSec: env.ACTIVE_TIMEOUT_SEC,
    staleTimeoutSec: env.STALE_TIMEOUT_SEC,
    enablePokeapiSprites: env.ENABLE_POKEAPI_SPRITES
  };

  const cliConfig = {
    port: argMap.port,
    host: argMap.host,
    claudeProjectsPath: argMap.claudeProjectsPath || argMap.path || argMap.claudePath,
    activeTimeoutSec: argMap.activeTimeoutSec || argMap.activeTimeout,
    staleTimeoutSec: argMap.staleTimeoutSec || argMap.staleTimeout,
    enablePokeapiSprites: argMap.enablePokeapiSprites
  };

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...vscodeLayer,
    ...envConfig,
    ...cliConfig
  };

  const config = {
    port: parseNumber(merged.port, DEFAULTS.port),
    host: merged.host || DEFAULTS.host,
    claudeProjectsPath: path.resolve(expandHome(merged.claudeProjectsPath || DEFAULTS.claudeProjectsPath)),
    activeTimeoutSec: parseNumber(merged.activeTimeoutSec, DEFAULTS.activeTimeoutSec),
    staleTimeoutSec: parseNumber(merged.staleTimeoutSec, DEFAULTS.staleTimeoutSec),
    enablePokeapiSprites: parseBoolean(merged.enablePokeapiSprites, DEFAULTS.enablePokeapiSprites),
    isMockMode: command === 'mock'
  };

  if (config.isMockMode) {
    if (config.activeTimeoutSec === DEFAULTS.activeTimeoutSec) {
      config.activeTimeoutSec = MOCK_TIMEOUT_DEFAULTS.activeTimeoutSec;
    }
    if (config.staleTimeoutSec === DEFAULTS.staleTimeoutSec) {
      config.staleTimeoutSec = MOCK_TIMEOUT_DEFAULTS.staleTimeoutSec;
    }
  }

  return config;
}

function resolveCli(argv, options = {}) {
  const argMap = parseArgv(argv);
  const command = argMap.help ? 'help' : argMap._[0] || 'watch';
  return {
    command,
    config: resolveUnified({
      source: 'web',
      configJsonPath: argMap.config || path.join(process.cwd(), 'config.json'),
      env: options.env || process.env,
      cli: { command, args: argMap }
    })
  };
}

module.exports = {
  DEFAULTS,
  MOCK_TIMEOUT_DEFAULTS,
  expandHome,
  parseBoolean,
  parseNumber,
  parseArgv,
  loadConfigFile,
  resolveUnified,
  resolveCli
};
