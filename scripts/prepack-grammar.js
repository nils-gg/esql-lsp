#!/usr/bin/env node
/**
 * prepack: make the packed tarball self-contained.
 *
 * `tree-sitter-esql` is a `file:` dependency that exists only inside this repo,
 * so a registry install of the LSP tarball would die on a 404 for it. npm's own
 * `bundleDependencies` cannot be used instead: it copies the *installed* grammar
 * folder, which at pack time already contains the locally compiled native addon
 * (`build/`) — a platform-specific binary that must never be installed on
 * another platform. So this step vendors the grammar's published file list and
 * `parser.ts` loads it from there (see `locateGrammar()`).
 *
 * The addon itself is deliberately NOT vendored: scripts/build-grammar.js
 * compiles it after install, and where that is impossible (no C toolchain) the
 * server takes the tested heuristic path instead.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'tree-sitter-esql');
const dest = path.join(root, 'vendor', 'tree-sitter-esql');

/** Not needed at runtime: the corpus tests, and prebuilds if they ever exist. */
const SKIP = new Set(['test', 'prebuilds']);

function countFiles(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return 1;
  let total = 0;
  for (const entry of fs.readdirSync(target)) total += countFiles(path.join(target, entry));
  return total;
}

function main() {
  if (!fs.existsSync(source)) {
    console.error(`esql-lsp: cannot vendor the grammar, ${source} is missing`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const entries = [...(manifest.files || []), 'package.json'].filter((e) => !SKIP.has(e));

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  let files = 0;
  for (const entry of entries) {
    const from = path.join(source, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dest, entry), { recursive: true });
    files += countFiles(from);
  }

  // Belt and braces: a compiled addon must never ride along.
  fs.rmSync(path.join(dest, 'build'), { recursive: true, force: true });
  fs.rmSync(path.join(dest, 'node_modules'), { recursive: true, force: true });

  console.log(
    `esql-lsp: vendored ${files} grammar files into ${path.relative(root, dest)} ` +
      '(the native addon is built by scripts/build-grammar.js after install)'
  );
}

main();
