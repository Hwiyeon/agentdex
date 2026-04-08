'use strict';

const tests = [];
let only = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test.only = function (name, fn) {
  only.push({ name, fn });
};

async function run() {
  const suite = only.length > 0 ? only : tests;
  let passed = 0;
  let failed = 0;

  for (const t of suite) {
    try {
      await t.fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
      console.log(`    ${err.message}`);
      if (err.stack) {
        const lines = err.stack.split('\n').slice(1, 4);
        for (const line of lines) {
          console.log(`    ${line.trim()}`);
        }
      }
    }
  }

  console.log(`\n  ${passed} passing, ${failed} failing\n`);
  if (failed > 0) process.exitCode = 1;
}

module.exports = { test, run };
