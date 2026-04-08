'use strict';

const { test, run } = require('./runner');
const assert = require('assert').strict;

const {
  SPRITE_SPARSE_PATHS,
  parseGitLinkCommit
} = require('../tools/setup_poke_assets');

test('asset setup sparse paths cover runtime sprites plus items', () => {
  assert.deepEqual(SPRITE_SPARSE_PATHS, [
    'sprites/pokemon/versions/generation-v/black-white',
    'sprites/pokemon/versions/generation-v/icons',
    'sprites/items'
  ]);
});

test('asset setup parses pinned gitlink commits from ls-tree output', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const stdout = `160000 commit ${sha}\tpublic/vendor/pokeapi-sprites\n`;
  assert.equal(parseGitLinkCommit(stdout), sha);
  assert.equal(parseGitLinkCommit('100644 blob abc\tREADME.md\n'), null);
});

run();
