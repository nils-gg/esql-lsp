#!/usr/bin/env node
/**
 * Packaging smoke test: proves the packed tarball is installable and usable.
 *
 * The grammar is a `file:` dependency, so a tarball that only declares it would
 * make `npm install esql-lsp` fail with a 404 (tree-sitter-esql is not on npm).
 * `scripts/prepack-grammar.js` vendors it; this script verifies the result the
 * way a user experiences it:
 *
 *   1. the tarball carries the grammar sources and no compiled addon
 *   2. installing it with --ignore-scripts gives a working heuristic-mode server
 *   3. installing it normally builds the addon and enables grammar mode
 *      (asserted only with --expect-grammar, i.e. on a machine with a toolchain)
 *
 * Usage: node scripts/verify-package.js [--expect-grammar] [--keep]
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const expectGrammar = argv.includes('--expect-grammar');
const keep = argv.includes('--keep');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-lsp-package-'));
let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * npm's real name on this platform. `spawnSync('npm')` works on POSIX because npm
 * ships a shell script there; on Windows npm is `npm.cmd`, and `spawnSync` without
 * a shell will not resolve `.cmd` — it fails with ENOENT and looks exactly like a
 * missing npm install. The CI platform matrix exists to exercise this path.
 */
function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
  if (r.error) {
    throw new Error(`${cmd} ${args.join(' ')} could not be started: ${r.error.message}`, {
      cause: r.error,
    });
  }
  return r;
}

/** Runs a snippet in a separate node process (module caches must not be shared). */
function probe(consumerDir, snippet) {
  const pkg = path.join(consumerDir, 'node_modules', 'esql-lsp');
  const file = path.join(consumerDir, 'probe.js');
  fs.writeFileSync(
    file,
    `global.ESQL_PKG = ${JSON.stringify(pkg)};\n` +
      `global.PROBE_SOURCE = ${JSON.stringify(SOURCE)};\n` +
      `(${snippet.toString()})()\n` +
      '  .then((out) => process.stdout.write(String(out)))\n' +
      "  .catch((err) => { process.stdout.write('probe error: ' + (err && err.stack)); process.exitCode = 1; });\n"
  );
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

const SOURCE = [
  'BROKER SCHEMA com.acme;',
  'CREATE COMPUTE MODULE M',
  'DECLARE counter INTEGER;',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  'SET counter = 1;',
  'RETURN TRUE;',
  'END;',
  'END MODULE;',
  '',
].join('\n');

/** What an installed server must answer, in either mode. */
function probeInstalled() {
  const parser = require(global.ESQL_PKG + '/dist/src/parser.js');
  const definitions = require(global.ESQL_PKG + '/dist/src/definitions.js');
  const symbols = require(global.ESQL_PKG + '/dist/src/symbols.js');
  const src = global.PROBE_SOURCE;
  return parser.initGrammar().then((ready) => {
    const tree = parser.parse(src);
    const doc = tree ? parser.analyzeDocument(tree) : undefined;
    // `SET counter = 1;` on line 5 must resolve to the DECLARE on line 2.
    const decl = definitions.definitionAt(src, 5, 5, doc);
    const outline = doc ? symbols.documentSymbolsFromTree(doc) : symbols.documentSymbols(src);
    return JSON.stringify({
      ready,
      module: outline.find((s) => s.name === 'M') ? 'M' : null,
      definition: decl.length ? decl[0].start : null,
    });
  });
}

function main() {
  console.log(`esql-lsp packaging check (work dir ${work})`);

  // ── 1. pack ──────────────────────────────────────────────────────────────
  const packed = run(npmCommand(), ['pack', '--pack-destination', work]);
  if (packed.status !== 0) {
    console.error(packed.stderr);
    throw new Error('npm pack failed');
  }
  // /\r?\n/ everywhere output is split: Windows' bsdtar and npm print CRLF, and a
  // stray \r silently breaks the tarball-name/regex comparisons downstream.
  const tarball = path.join(work, packed.stdout.trim().split(/\r?\n/).pop());
  const listed = run('tar', ['-tzf', tarball]).stdout.split(/\r?\n/);

  check('tarball carries the compiled server', listed.some((l) => /dist\/src\/server\.js$/.test(l)), 'bin/esql-lsp.js requires dist/src/server.js, so prepack must build');
  check('tarball carries the vendored grammar parser', listed.some((l) => /vendor\/tree-sitter-esql\/src\/parser\.c$/.test(l)));
  check('tarball carries the highlight queries', listed.some((l) => /vendor\/tree-sitter-esql\/queries\/highlights\.scm$/.test(l)));
  check('tarball carries no compiled addon', !listed.some((l) => l.endsWith('.node')), 'a platform-specific binary must not ship');
  check('tarball carries no bundled node_modules', !listed.some((l) => /^package\/node_modules\//.test(l)));

  const manifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']).stdout);
  check(
    'published manifest has no file: dependency',
    !Object.values(manifest.dependencies || {}).some((v) => String(v).startsWith('file:')),
    JSON.stringify(manifest.dependencies)
  );

  // ── 2. install without running scripts (no-toolchain user) ───────────────
  const degraded = path.join(work, 'consumer-no-scripts');
  fs.mkdirSync(degraded, { recursive: true });
  run(npmCommand(), ['init', '-y'], { cwd: degraded });
  const installDegraded = run(npmCommand(), ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], {
    cwd: degraded,
  });
  if (installDegraded.status !== 0) {
    console.error(installDegraded.stderr);
    throw new Error('installing the tarball with --ignore-scripts failed');
  }
  check('installs from the tarball with --ignore-scripts', true);

  const degradedOut = probe(degraded, probeInstalled);
  let degradedResult = {};
  try {
    degradedResult = JSON.parse(degradedOut);
  } catch {
    /* reported by the check below */
  }
  check(
    'heuristic-mode server answers after a script-less install',
    degradedResult.ready === false &&
      degradedResult.module === 'M' &&
      degradedResult.definition &&
      degradedResult.definition.line === 2,
    degradedOut
  );

  // ── 3. install with the addon built (normal user) ────────────────────────
  const built = path.join(work, 'consumer-built');
  fs.mkdirSync(built, { recursive: true });
  run(npmCommand(), ['init', '-y'], { cwd: built });
  const installBuilt = run(npmCommand(), ['install', '--no-audit', '--no-fund', tarball], { cwd: built });
  check('installing the tarball runs the grammar build', installBuilt.status === 0);
  const builtOut = probe(built, probeInstalled);
  let builtResult = {};
  try {
    builtResult = JSON.parse(builtOut);
  } catch {
    /* reported below */
  }
  const usable =
    builtResult.module === 'M' &&
    builtResult.definition &&
    builtResult.definition.line === 2;
  if (expectGrammar) {
    check('grammar-mode server answers after a normal install', builtResult.ready === true && usable, builtOut);
  } else if (builtResult.ready === true) {
    console.log('PASS  grammar-mode server answers after a normal install');
  } else {
    console.log(`NOTE  addon not built here (no C toolchain?) — heuristics still answer: ${builtOut}`);
    if (!usable) check('installed server answers in grammar-mode attempt', false, builtOut);
  }

  if (!keep) {
    fs.rmSync(work, { recursive: true, force: true });
  } else {
    console.log(`kept ${work}`);
  }

  if (failures) {
    console.error(`\n${failures} packaging check(s) failed`);
    process.exit(1);
  }
  console.log('all packaging checks passed');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
