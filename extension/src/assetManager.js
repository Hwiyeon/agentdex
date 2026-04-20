'use strict';

const fs = require('fs');
const path = require('path');
const spriteFetcher = require('./spriteFetcher');

const INSTALL_STATE_FILE = '.install-state.json';
const LAYOUT_VERSION = 1;
const LOGICAL_KINDS = ['static', 'animated', 'icon', 'icon-static'];

function spriteLogicalPath(rootDir, kind, fileName) {
  return path.join(rootDir, kind, fileName);
}

function ensureSpriteDirs(rootDir) {
  for (const kind of LOGICAL_KINDS) {
    fs.mkdirSync(path.join(rootDir, kind), { recursive: true });
  }
}

function readInstallState(rootDir) {
  const filePath = path.join(rootDir, INSTALL_STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeInstallState(rootDir, installState) {
  ensureSpriteDirs(rootDir);
  fs.writeFileSync(
    path.join(rootDir, INSTALL_STATE_FILE),
    JSON.stringify(installState, null, 2),
    'utf8'
  );
}

function modeSatisfied(installedMode, desiredMode) {
  return installedMode === desiredMode || installedMode === 'full';
}

async function ensureSprites(rootDir, mode, options = {}) {
  const desiredMode = mode === 'lite' ? 'lite' : 'full';
  const existing = readInstallState(rootDir);
  if (existing && existing.layoutVersion === LAYOUT_VERSION && modeSatisfied(existing.mode, desiredMode)) {
    return {
      skipped: true,
      installState: existing
    };
  }

  ensureSpriteDirs(rootDir);

  if (options.skipDownload) {
    const installState = {
      mode: desiredMode,
      layoutVersion: LAYOUT_VERSION,
      completedAt: new Date().toISOString()
    };
    writeInstallState(rootDir, installState);
    return {
      skipped: false,
      simulated: true,
      installState
    };
  }

  const fetcher = options.fetcher || spriteFetcher;
  const fetchOptions = {
    progress: options.progress,
    maxIds: options.maxIds,
    maxConcurrency: options.maxConcurrency
  };

  if (desiredMode === 'full') {
    await fetcher.fetchFull(rootDir, fetchOptions);
  } else {
    await fetcher.fetchLite(rootDir, fetchOptions);
  }

  const installState = {
    mode: desiredMode,
    layoutVersion: LAYOUT_VERSION,
    completedAt: new Date().toISOString()
  };
  writeInstallState(rootDir, installState);
  return {
    skipped: false,
    installState
  };
}

module.exports = {
  INSTALL_STATE_FILE,
  LAYOUT_VERSION,
  LOGICAL_KINDS,
  spriteLogicalPath,
  readInstallState,
  ensureSprites
};
