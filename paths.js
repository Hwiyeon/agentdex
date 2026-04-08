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

function spriteCandidates(kind, fileName) {
  if (kind === 'static') {
    return [
      path.join(GEN5_STATIC_DIR, fileName)
    ];
  }

  if (kind === 'animated') {
    return [
      path.join(GEN5_ANIMATED_DIR, fileName)
    ];
  }

  if (kind === 'icon') {
    return [
      path.join(GEN5_ICON_ANIMATED_DIR, fileName),
      path.join(GEN5_ICON_DIR, fileName)
    ];
  }

  if (kind === 'icon-static') {
    return [
      path.join(GEN5_ICON_DIR, fileName)
    ];
  }

  return [];
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
  spriteCandidates
};
