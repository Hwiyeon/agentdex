'use strict';

const assert = require('assert').strict;
const { test, run } = require('./runner');
const { buildWebviewHtml } = require('../extension/src/htmlTemplate');

test('html template injects CSP, asset bases, and rewritten resource URLs', () => {
  const html = buildWebviewHtml({
    htmlRaw: [
      '<!doctype html>',
      '<html><head>',
      '<link rel="stylesheet" href="/style.css" />',
      '</head><body>',
      '<script src="/app.js"></script>',
      '</body></html>'
    ].join(''),
    cssUri: 'vscode-resource:/style.css',
    jsUri: 'vscode-resource:/app.js',
    assetBase: 'vscode-resource:/assets',
    dataBase: 'vscode-resource:/data',
    cspSource: 'vscode-webview://test'
  });

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src vscode-webview:\/\/test/);
  assert.match(html, /script-src 'nonce-/);
  assert.match(html, /href="vscode-resource:\/style\.css"/);
  assert.match(html, /src="vscode-resource:\/app\.js"/);
  assert.match(html, /__PAS_ASSET_BASE__/);
  assert.match(html, /__PAS_DATA_BASE__/);
});

run();
