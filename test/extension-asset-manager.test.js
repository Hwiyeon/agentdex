'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const { spriteCandidatesIn } = require('../paths');
const { ensureSprites, readInstallState } = require('../extension/src/assetManager');

test('asset manager writes install metadata and supports mode upgrades', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pas-assets-'));

  const lite = await ensureSprites(tempRoot, 'lite', { skipDownload: true });
  assert.equal(lite.skipped, false);
  assert.equal(readInstallState(tempRoot).mode, 'lite');

  const full = await ensureSprites(tempRoot, 'full', { skipDownload: true });
  assert.equal(full.skipped, false);
  assert.equal(readInstallState(tempRoot).mode, 'full');
});

test('spriteCandidatesIn prefers logical layout and keeps nested fallback', () => {
  const rootDir = path.resolve('/tmp/assets');
  const candidates = spriteCandidatesIn(rootDir, 'static', '1.png');
  assert.equal(candidates[0], path.join(rootDir, 'static', '1.png'));
  assert.equal(candidates[1], path.join(rootDir, 'sprites', 'pokemon', 'versions', 'generation-v', 'black-white', '1.png'));
});

run();
