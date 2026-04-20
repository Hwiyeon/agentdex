'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v';

function requestBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects > 5) {
          reject(new Error(`too many redirects for ${url}`));
          return;
        }
        resolve(requestBuffer(response.headers.location, redirects + 1));
        return;
      }

      if (response.statusCode !== 200) {
        const error = new Error(`request failed (${response.statusCode}) for ${url}`);
        error.code = `HTTP_${response.statusCode}`;
        response.resume();
        reject(error);
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function downloadWithRetries(url, targetPath, retries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const buffer = await requestBuffer(url);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, buffer);
      return true;
    } catch (error) {
      lastError = error;
      if (error.code === 'HTTP_404') break;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw lastError;
}

async function downloadFirstAvailable(urls, targetPath, retries = 3) {
  let lastError = null;
  for (const url of urls) {
    try {
      await downloadWithRetries(url, targetPath, retries);
      return true;
    } catch (error) {
      lastError = error;
      if (error.code !== 'HTTP_404') {
        throw error;
      }
    }
  }
  throw lastError;
}

async function runQueue(tasks, maxConcurrency) {
  let index = 0;
  const workers = new Array(Math.max(1, maxConcurrency)).fill(null).map(async () => {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      await tasks[current]();
    }
  });
  await Promise.all(workers);
}

function buildPlans(mode, maxIds) {
  const ids = [];
  for (let id = 1; id <= maxIds; id += 1) {
    ids.push(String(id));
  }

  const plans = [];
  for (const id of ids) {
    plans.push({
      kind: 'static',
      fileName: `${id}.png`,
      urls: [`${BASE_URL}/black-white/${id}.png`]
    });
    plans.push({
      kind: 'animated',
      fileName: `${id}.gif`,
      urls: [`${BASE_URL}/black-white/animated/${id}.gif`]
    });
    plans.push({
      kind: 'icon',
      fileName: `${id}.png`,
      urls: [
        `${BASE_URL}/icons/animated/${id}.png`,
        `${BASE_URL}/icons/${id}.png`
      ]
    });
    plans.push({
      kind: 'icon-static',
      fileName: `${id}.png`,
      urls: [`${BASE_URL}/icons/${id}.png`]
    });
  }

  if (mode === 'lite') {
    return plans;
  }
  return plans;
}

async function fetchByMode(targetDir, mode, options = {}) {
  const maxIds = Math.max(1, Number(options.maxIds) || 251);
  const maxConcurrency = Math.max(1, Number(options.maxConcurrency) || 8);
  const progress = typeof options.progress === 'function' ? options.progress : null;
  const plans = buildPlans(mode, maxIds);
  let completed = 0;

  await runQueue(plans.map((plan) => async () => {
    const targetPath = path.join(targetDir, plan.kind, plan.fileName);
    await downloadFirstAvailable(plan.urls, targetPath, 3);
    completed += 1;
    if (progress) {
      progress({
        completed,
        total: plans.length,
        label: `${plan.kind}/${plan.fileName}`
      });
    }
  }), maxConcurrency);
}

async function fetchLite(targetDir, options = {}) {
  await fetchByMode(targetDir, 'lite', options);
}

async function fetchFull(targetDir, options = {}) {
  await fetchByMode(targetDir, 'full', options);
}

module.exports = {
  fetchLite,
  fetchFull
};
