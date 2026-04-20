'use strict';

const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname);
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
const POKEAPI_SPRITES_DIR = path.join(VENDOR_DIR, 'pokeapi-sprites');
const POKEAPI_CACHE_DIR = path.join(VENDOR_DIR, 'pokeapi-cache');
const POKEAPI_POKEMON_DIR = path.join(POKEAPI_SPRITES_DIR, 'sprites', 'pokemon');
const GEN5_DIR = path.join(POKEAPI_POKEMON_DIR, 'versions', 'generation-v', 'black-white');
const GEN5_STATIC_DIR = GEN5_DIR;
const GEN5_ANIMATED_DIR = path.join(GEN5_DIR, 'animated');
const GEN5_ICON_DIR = path.join(POKEAPI_POKEMON_DIR, 'versions', 'generation-v', 'icons');
const GEN5_ICON_ANIMATED_DIR = path.join(GEN5_ICON_DIR, 'animated');

function spriteCandidatesIn(rootDir, kind, fileName) {
  const logicalRoot = path.resolve(rootDir);
  const logicalPath = path.join(logicalRoot, kind, fileName);
  const gen5Dir = path.join(logicalRoot, 'sprites', 'pokemon', 'versions', 'generation-v');
  const blackWhiteDir = path.join(gen5Dir, 'black-white');
  const iconsDir = path.join(gen5Dir, 'icons');

  if (kind === 'static') {
    return [
      logicalPath,
      path.join(blackWhiteDir, fileName)
    ];
  }

  if (kind === 'animated') {
    return [
      logicalPath,
      path.join(blackWhiteDir, 'animated', fileName)
    ];
  }

  if (kind === 'icon') {
    return [
      logicalPath,
      path.join(iconsDir, 'animated', fileName),
      path.join(iconsDir, fileName),
      path.join(logicalRoot, 'icon-static', fileName)
    ];
  }

  if (kind === 'icon-static') {
    return [
      logicalPath,
      path.join(iconsDir, fileName)
    ];
  }

  return [];
}

function spriteCandidates(kind, fileName) {
  return spriteCandidatesIn(POKEAPI_SPRITES_DIR, kind, fileName);
}

module.exports = {
  PROJECT_ROOT,
  PUBLIC_DIR,
  DATA_DIR,
  VENDOR_DIR,
  POKEAPI_SPRITES_DIR,
  POKEAPI_CACHE_DIR,
  POKEAPI_POKEMON_DIR,
  GEN5_DIR,
  GEN5_STATIC_DIR,
  GEN5_ANIMATED_DIR,
  GEN5_ICON_DIR,
  GEN5_ICON_ANIMATED_DIR,
  spriteCandidates,
  spriteCandidatesIn
};
