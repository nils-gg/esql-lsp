#!/usr/bin/env node
/**
 * postinstall: try to compile the vendored grammar addon.
 *
 * This is best effort and NEVER fails the install. A machine without a C
 * toolchain (or an `npm install --ignore-scripts`) simply keeps no
 * `vendor/tree-sitter-esql/build/*.node`, and the server logs that it is
 * running the heuristic mode — the same degradation path every grammar feature
 * is required to have, and which the test suite covers.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendored = path.join(root, 'vendor', 'tree-sitter-esql');

function compiledAddonExists(dir) {
  const candidates = [
    path.join(dir, 'build', 'Release'),
    path.join(dir, 'build', 'Debug'),
    path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`),
  ];
  return candidates.some(
    (dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.node'))
  );
}

/** Prefer a resolvable node-gyp; npm also puts its own node-gyp on PATH. */
function nodeGypCommand() {
  try {
    const bin = require.resolve('node-gyp/bin/node-gyp.js');
    return { cmd: process.execPath, args: [bin] };
  } catch {
    return { cmd: 'node-gyp', args: [] };
  }
}

function main() {
  // Development checkout: the grammar is an installed dependency and npm has
  // already run its own build; vendoring only exists for packed tarballs.
  if (fs.existsSync(path.join(root, 'node_modules', 'tree-sitter-esql'))) return;
  if (!fs.existsSync(path.join(vendored, 'binding.gyp'))) return;
  if (compiledAddonExists(vendored)) return;

  const { cmd, args } = nodeGypCommand();
  const result = spawnSync(cmd, [...args, 'rebuild'], { cwd: vendored, stdio: 'inherit' });
  if (!result.error && !result.status) {
    console.log('esql-lsp: grammar addon built — parse-tree features enabled');
    return;
  }
  console.log(
    'esql-lsp: could not build the tree-sitter grammar addon (' +
      (result.error ? result.error.message : `node-gyp exited ${result.status}`) +
      '). esql-lsp still works: diagnostics, completion, hover, symbols, definitions\n' +
      '          and references run on the built-in heuristics. See README "Grammar mode".'
  );
}

try {
  main();
} catch (err) {
  // Never break `npm install` over an optional native build.
  console.log(`esql-lsp: grammar addon build skipped: ${err && err.message}`);
}
