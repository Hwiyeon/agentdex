#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  PROJECT_ROOT,
  POKEAPI_CACHE_DIR,
  POKEAPI_SPRITES_DIR,
  GEN5_STATIC_DIR,
  GEN5_ANIMATED_DIR,
  GEN5_ICON_DIR,
  GEN5_ICON_ANIMATED_DIR
} = require('../paths');

const LEGACY_CACHE_DIR = path.join(PROJECT_ROOT, '.pokemon_cache');
const SUBMODULE_PATH = path.relative(PROJECT_ROOT, POKEAPI_SPRITES_DIR);
const SUBMODULE_GIT_DIR = path.join(PROJECT_ROOT, '.git', 'modules', 'public', 'vendor', 'pokeapi-sprites');
const SUBMODULE_URL = 'https://github.com/PokeAPI/sprites.git';
const POKEAPI_ITEMS_DIR = path.join(POKEAPI_SPRITES_DIR, 'sprites', 'items');
const SPRITE_SPARSE_PATHS = [
  'sprites/pokemon/versions/generation-v/black-white',
  'sprites/pokemon/versions/generation-v/icons',
  'sprites/items'
];

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd || PROJECT_ROOT,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function tryGit(args, options = {}) {
  return spawnSync('git', args, {
    cwd: options.cwd || PROJECT_ROOT,
    stdio: 'pipe',
    encoding: 'utf8'
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function moveLegacyCache() {
  const targetExists = fs.existsSync(POKEAPI_CACHE_DIR);
  const targetEmpty = targetExists && fs.readdirSync(POKEAPI_CACHE_DIR).length === 0;
  if (!fs.existsSync(LEGACY_CACHE_DIR) || (targetExists && !targetEmpty)) {
    return;
  }

  ensureDir(path.dirname(POKEAPI_CACHE_DIR));
  if (targetEmpty) {
    fs.rmdirSync(POKEAPI_CACHE_DIR);
  }
  fs.renameSync(LEGACY_CACHE_DIR, POKEAPI_CACHE_DIR);
  process.stdout.write(`[assets] moved legacy cache to ${POKEAPI_CACHE_DIR}\n`);
}

function parseGitLinkCommit(stdout) {
  const match = String(stdout || '').match(/160000 commit ([0-9a-f]{40})\t/);
  return match ? match[1] : null;
}

function getPinnedSpriteRef() {
  const result = tryGit(['ls-tree', 'HEAD', '--', SUBMODULE_PATH]);
  if (result.status !== 0) {
    return null;
  }
  return parseGitLinkCommit(result.stdout);
}

function hasSpriteCheckout() {
  return fs.existsSync(path.join(POKEAPI_SPRITES_DIR, '.git'));
}

function isDirectoryEmpty(dirPath) {
  return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0;
}

function ensureCheckoutRoot() {
  ensureDir(path.dirname(POKEAPI_SPRITES_DIR));

  if (!fs.existsSync(POKEAPI_SPRITES_DIR)) {
    return;
  }

  if (hasSpriteCheckout()) {
    return;
  }

  if (isDirectoryEmpty(POKEAPI_SPRITES_DIR)) {
    fs.rmdirSync(POKEAPI_SPRITES_DIR);
    return;
  }

  process.stderr.write('[assets] existing pokeapi sprite directory is not a git checkout:\n');
  process.stderr.write(`  - ${POKEAPI_SPRITES_DIR}\n`);
  process.stderr.write('[assets] remove or rename it, then rerun this setup.\n');
  process.exit(1);
}

function configureSparseCheckout() {
  ensureDir(POKEAPI_SPRITES_DIR);
  runGit(['-C', POKEAPI_SPRITES_DIR, 'config', 'core.sparseCheckout', 'true']);
  runGit(['-C', POKEAPI_SPRITES_DIR, 'config', 'remote.origin.promisor', 'true']);
  runGit(['-C', POKEAPI_SPRITES_DIR, 'config', 'remote.origin.partialclonefilter', 'blob:none']);
  runGit(['-C', POKEAPI_SPRITES_DIR, 'sparse-checkout', 'init', '--cone']);
  runGit(['-C', POKEAPI_SPRITES_DIR, 'sparse-checkout', 'set', ...SPRITE_SPARSE_PATHS]);
}

function cloneSparseCheckout() {
  process.stdout.write('[assets] cloning sparse pokeapi sprites checkout\n');
  ensureDir(path.dirname(SUBMODULE_GIT_DIR));
  runGit([
    'clone',
    '--depth', '1',
    '--no-tags',
    '--filter=blob:none',
    '--sparse',
    '--separate-git-dir', SUBMODULE_GIT_DIR,
    SUBMODULE_URL,
    POKEAPI_SPRITES_DIR
  ]);
  configureSparseCheckout();
}

function isCheckoutDirty() {
  const result = tryGit(['-C', POKEAPI_SPRITES_DIR, 'status', '--porcelain']);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function syncCheckout(ref) {
  if (!ref) {
    process.stdout.write('[assets] could not resolve pinned sprite commit; keeping current checkout\n');
    return;
  }

  if (isCheckoutDirty()) {
    process.stdout.write('[assets] sprite checkout has local changes; skipping ref sync\n');
    return;
  }

  const current = tryGit(['-C', POKEAPI_SPRITES_DIR, 'rev-parse', 'HEAD']);
  if (current.status === 0 && current.stdout.trim() === ref) {
    process.stdout.write('[assets] pokeapi sprites already at pinned commit\n');
    return;
  }

  process.stdout.write(`[assets] syncing pokeapi sprites to ${ref.slice(0, 12)}\n`);
  runGit(['-C', POKEAPI_SPRITES_DIR, 'fetch', '--depth', '1', '--no-tags', '--filter=blob:none', 'origin', ref]);
  runGit(['-C', POKEAPI_SPRITES_DIR, 'checkout', '--detach', 'FETCH_HEAD']);
  runGit(['-C', POKEAPI_SPRITES_DIR, 'sparse-checkout', 'reapply']);
}

function ensureSpriteCheckout() {
  const pinnedRef = getPinnedSpriteRef();

  ensureCheckoutRoot();

  if (!hasSpriteCheckout()) {
    cloneSparseCheckout();
  } else {
    process.stdout.write('[assets] using existing pokeapi sprites checkout\n');
    configureSparseCheckout();
  }

  syncCheckout(pinnedRef);
}

function validateSpriteDirs() {
  const requiredDirs = [
    GEN5_STATIC_DIR,
    GEN5_ANIMATED_DIR,
    GEN5_ICON_DIR,
    GEN5_ICON_ANIMATED_DIR,
    POKEAPI_ITEMS_DIR
  ];

  const missing = requiredDirs.filter((dirPath) => !fs.existsSync(dirPath));
  if (missing.length === 0) {
    return;
  }

  process.stderr.write('[assets] pokeapi sprites checkout is missing expected sparse paths:\n');
  for (const dirPath of missing) {
    process.stderr.write(`  - ${dirPath}\n`);
  }
  process.exit(1);
}

function main() {
  ensureSpriteCheckout();

  moveLegacyCache();
  ensureDir(POKEAPI_CACHE_DIR);
  validateSpriteDirs();

  process.stdout.write(`[assets] sparse paths: ${SPRITE_SPARSE_PATHS.join(', ')}\n`);
  process.stdout.write(`[assets] sprites ready at ${POKEAPI_SPRITES_DIR}\n`);
  process.stdout.write(`[assets] cache ready at ${POKEAPI_CACHE_DIR}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  SPRITE_SPARSE_PATHS,
  parseGitLinkCommit
};
