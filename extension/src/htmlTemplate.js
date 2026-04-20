'use strict';

const crypto = require('crypto');

function buildWebviewHtml(options = {}) {
  const nonce = options.nonce || crypto.randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `img-src ${options.cspSource} data:`,
    `connect-src ${options.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `style-src ${options.cspSource} 'unsafe-inline'`
  ].join('; ');

  return options.htmlRaw
    .replace(
      '</head>',
      `  <meta http-equiv="Content-Security-Policy" content="${csp}">\n</head>`
    )
    .replace('href="/style.css"', `href="${options.cssUri}"`)
    .replace(
      '<script src="/app.js"></script>',
      `<script nonce="${nonce}">
         window.__PAS_ASSET_BASE__=${JSON.stringify(options.assetBase)};
         window.__PAS_DATA_BASE__=${JSON.stringify(options.dataBase)};
       </script>
       <script nonce="${nonce}" src="${options.jsUri}"></script>`
    );
}

module.exports = {
  buildWebviewHtml
};
