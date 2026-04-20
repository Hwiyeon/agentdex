'use strict';

let cliModule = null;
let extensionModule = null;

function getCli() {
  if (!cliModule) {
    cliModule = require('./cli');
  }
  return cliModule;
}

function getExtension() {
  if (!extensionModule) {
    extensionModule = require('./extension/src/extension');
  }
  return extensionModule;
}

async function activate(context) {
  return getExtension().activate(context);
}

async function deactivate() {
  if (!extensionModule || typeof extensionModule.deactivate !== 'function') {
    return undefined;
  }
  return extensionModule.deactivate();
}

const exported = {
  activate,
  deactivate
};

for (const key of [
  'DEFAULTS',
  'resolveConfig',
  'createMockDriver',
  'getPersistencePaths',
  'saveState',
  'loadState',
  'savePokedex',
  'loadPokedex',
  'clearPersistedFiles',
  'performDashboardHardReset',
  'readLiveSessionIds',
  'run'
]) {
  Object.defineProperty(exported, key, {
    enumerable: false,
    get() {
      return getCli()[key];
    }
  });
}

module.exports = exported;

if (require.main === module) {
  getCli().run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
