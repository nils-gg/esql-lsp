#!/usr/bin/env node
// Grammar-level scan: how does tree-sitter actually parse the real files?
// Reports ERROR / MISSING nodes with the source text they cover.
'use strict';
const fs = require('fs');
const path = require('path');
/**
 * Args accept BOTH `--name=value` and `--name value`. The archived version of
 * these probes only read the `=` form, so `--corpus <dir>` silently fell back to
 * scanning the probe's own directory — a 123-file run of pure phantom findings.
 * An unrecognised flag is an error for the same reason: a flag that is not read
 * is a result that is not real.
 */
const KNOWN_ARGS = new Set(['corpus', 'out', 'mode', 'phases', 'only', 'limit', 'hold', 'boot', 'reqTimeout', 'file', 'heuristic']);
const arg = (n, d) => {
  const a = process.argv.slice(2);
  const eq = a.find((x) => x.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = a.indexOf(`--${n}`);
  if (i >= 0 && a[i + 1] !== undefined && !a[i + 1].startsWith('--')) return a[i + 1];
  return d;
};
{
  const bad = process.argv.slice(2).filter((x) => x.startsWith('--') && !KNOWN_ARGS.has(x.slice(2).split(/[=\s]/)[0]));
  if (bad.length) {
    console.error(`esql-lsp probe: unknown argument(s) ${bad.join(' ')}\n  known: ${[...KNOWN_ARGS].join(', ')}`);
    process.exit(2);
  }
}
/* Paths resolve from this file, so a probe works from any checkout. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO_ROOT, 'bin', 'esql-lsp.js');
const DIST = (m) => {
  try {
    return require(path.join(REPO_ROOT, 'dist', m));
  } catch (e) {
    console.error(`esql-lsp probe: cannot load dist/${m} (${e.code || e.message}).`);
    console.error('  These probes measure the BUILT server: run `npm run build` first.');
    process.exit(2);
  }
};
/** The corpus of real .esql files is never committed; see scripts/probe/README.md. */
const corpusDir = () => {
  const dir = arg('corpus', process.env.ESQL_CORPUS || '');
  if (!dir) {
    console.error('esql-lsp probe: no corpus given.');
    console.error('  Pass --corpus=<dir> (or --corpus <dir>, or set ESQL_CORPUS) pointing at a');
    console.error('  directory tree of real .esql files. Nothing can be measured without it:');
    console.error('  the corpus these probes were built on is 103 files from 11 public ACE');
    console.error('  repositories, listed in scripts/probe/README.md, and cannot be committed.');
    process.exit(2);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`esql-lsp probe: --corpus=${dir} is not a directory.`);
    process.exit(2);
  }
  return path.resolve(dir);
};
const ParserMod = require(path.join(REPO_ROOT, 'node_modules', 'tree-sitter'));
// the grammar package is "type": "module" -> needs a true dynamic import
const trueImport = new Function('s', 'return import(s)');
const GRAMMAR = path.join(REPO_ROOT, 'node_modules', 'tree-sitter-esql', 'bindings', 'node', 'index.js');

const corpus = corpusDir();
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.esql$/i.test(e.name)) files.push(p);
  }
})(corpus);
files.sort();

async function main() {
  const mod = await trueImport(GRAMMAR);
  const Grammar = mod.default ?? mod;
  const ParserClass = ParserMod.default ?? ParserMod;
  const parser = new ParserClass();
  parser.setLanguage(Grammar);

  const out = [];
  for (const abs of files) {
    const text = fs.readFileSync(abs, 'utf8');
    const tree = parser.parse(text);
    const problems = [];
    const walkNode = (node) => {
      if (node.type === 'ERROR' || node.type === 'MISSING' || node.isMissing) {
        problems.push({
          type: node.type,
          start: [node.startPosition.row, node.startPosition.column],
          end: [node.endPosition.row, node.endPosition.column],
          text: text.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 220)).replace(/\s+/g, ' '),
        });
      }
      for (const c of node.children) walkNode(c);
    };
    walkNode(tree.rootNode);
    out.push({ file: path.relative(corpus, abs), lines: text.split('\n').length, hasError: tree.rootNode.hasError, problems });
  }

  const clean = out.filter((o) => !o.problems.length);
  console.log(`files: ${out.length} | clean parse: ${clean.length} | files with ERROR/MISSING: ${out.length - clean.length}`);
  const counter = new Map();
  for (const o of out) for (const p of o.problems) counter.set(p.text, (counter.get(p.text) || 0) + 1);
  const filesBy = (frag) => new Set(out.filter((o) => o.problems.some((p) => p.text === frag)).map((o) => o.file)).size;
  console.log('\n=== distinct damaged source fragments ===');
  for (const [frag, n] of [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`${String(n).padStart(4)}x in ${String(filesBy(frag)).padStart(3)} file(s)  ${frag.slice(0, 150)}`);
  }
  console.log('\n=== per-file (only damaged ones) ===');
  for (const o of out.filter((x) => x.problems.length)) {
    console.log(`${o.file} (${o.lines} lines) ${o.problems.length} problem(s)`);
    for (const p of o.problems.slice(0, 3)) {
      console.log(`   ${p.type} L${p.start[0]}:${p.start[1]}-${p.end[0]}:${p.end[1]}  ${p.text.slice(0, 120)}`);
    }
  }
  fs.writeFileSync(path.resolve(arg('out', 'grammar-scan.json')), JSON.stringify(out, null, 1));
  console.log('\nwrote ' + path.resolve(arg('out', 'grammar-scan.json')));
}

main().catch((err) => {
  console.error('scan failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
