#!/usr/bin/env node
/**
 * Large-file analysis benchmark (ISSUES.md round-3 optional item).
 *
 * Answers "what does the per-edit path cost when the file stops being a
 * 12 KB demo and becomes a big old integration server?" — the I-20 cache made
 * repeat requests free, but the FIRST analysis of a large document still runs
 * on every keystroke-ish burst, and nobody had measured how it scales.
 *
 * It times the exact chain the server runs per content change — parse,
 * analyzeDocument, diagnostics — over a synthetic ESQL document grown to
 * target sizes, and prints a median-of-runs table. Synthetic on purpose: real
 * 370 KB ESQL files are rare, but the growth pattern (one module, one routine,
 * hundreds of DECLARE/SET lines — the shape of the largest real files in the
 * corpus, just longer) is what the analyzer's cost actually tracks.
 *
 * Modes: run normally for grammar mode (needs the built dist + addon), run
 * with ESQL_LSP_NO_GRAMMAR=1 for the heuristic path. The active mode is
 * printed — a table attributed to the wrong mode is the phantom-results
 * mistake this repo's probes already documented once.
 *
 * First finding, before any timings: the heuristic path indexes ONE
 * `DECLARE` per line, so two statements glued onto one line (`… 'seed';
 * DECLARE v0 CHARACTER;` — legal ESQL) leave `v0` undeclared there while the
 * tree path parses it fine. Zero occurrences in the 103-file corpus (the
 * heuristic mode reports no findings there), logged in ISSUES.md as a
 * measured limitation; the template below keeps one statement per line so
 * the table measures analysis cost, not that.
 *
 *   npm run build
 *   node scripts/probe/large-file-bench.js                 # grammar mode
 *   ESQL_LSP_NO_GRAMMAR=1 node scripts/probe/large-file-bench.js
 *   node scripts/probe/large-file-bench.js --sizes=12,50,370 --reps=5
 */
'use strict';

const path = require('path');

// ── arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
let sizes = [12, 25, 50, 100, 200, 370]; // KB targets
let reps = 5;
for (const a of argv) {
  if (a.startsWith('--sizes=')) {
    sizes = a
      .slice(8)
      .split(',')
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
  } else if (a.startsWith('--reps=')) {
    reps = Math.max(1, Number(a.slice(7)) || reps);
  } else {
    console.error(`unknown flag: ${a} (supported: --sizes=12,50,370 --reps=5)`);
    process.exit(2);
  }
}

// ── the built server's own modules (the same code path didOpen takes) ──────
const dist = path.join(__dirname, '..', '..', 'dist');
const { parse, analyzeDocument, initGrammar, grammarReady } = require(path.join(dist, 'src', 'parser.js'));
const { analyze } = require(path.join(dist, 'src', 'diagnostics.js'));
const { DEFAULT_SETTINGS } = require(path.join(dist, 'src', 'settings.js'));

// ── synthetic document ------------------------------------------------------
// One module/routine per file (the common real shape); the body grows with
// declared variables and SET statements, the construct every .esql has.
function documentOf(targetBytes) {
  const header = [
    'BROKER SCHEMA com.bench.big;',
    'CREATE COMPUTE MODULE BigModule',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  DECLARE x INT 0;',
    '  DECLARE s CHARACTER \'seed\';',
    '',
  ].join('\n');
  const footer = '\n  RETURN TRUE;\nEND\nEND MODULE;\n';
  const unit = (i) =>
    `  DECLARE v${i} CHARACTER;\n  SET v${i} = UPPER(s) || CAST(${i} AS CHARACTER);\n`;
  let body = '';
  let i = 0;
  while (header.length + body.length + footer.length < targetBytes) {
    body += unit(i++);
    if (i % 500 === 0) body += `  IF v${i - 1} = s THEN\n    SET x = x + 1;\n  END IF;\n`;
  }
  return header + body + footer;
}

// ── timing ------------------------------------------------------------------
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const now = () => {
  const [s, ns] = process.hrtime.bigint ? [0n, process.hrtime.bigint()] : [0, 0];
  return Number(ns) / 1e6; // ms monotonic
};

function measure(text) {
  const t0 = now();
  const tree = parse(text);
  const t1 = now();
  const analysis = tree ? analyzeDocument(tree, text) : null;
  const t2 = now();
  const diags = analyze(text, DEFAULT_SETTINGS.diagnostics, analysis ?? undefined);
  const t3 = now();
  // "clean" is about DOCUMENTS: a valid synthetic file must produce no
  // diagnostics in either mode. Heuristic mode has no tree at all, so it is
  // judged on diagnostics alone (grammar mode additionally needs the tree).
  return {
    bytes: text.length,
    parse: t1 - t0,
    analyze: t2 - t1,
    diagnostics: t3 - t2,
    total: t3 - t0,
    diags: diags.length,
    ok: diags.length === 0 && (!tree || analysis.syntaxIssues.length === 0),
  };
}

async function main() {
  const mode = process.env.ESQL_LSP_NO_GRAMMAR
    ? 'heuristic (ESQL_LSP_NO_GRAMMAR=1)'
    : (await initGrammar()) || grammarReady()
      ? 'grammar'
      : 'GRAMMAR UNAVAILABLE — results are the heuristic path despite no env flag!';
  console.log(`mode: ${mode}`);
  console.log(`reps: ${reps} (median reported)\n`);
  const rows = [];
  for (const kb of sizes) {
    const text = documentOf(kb * 1024);
    const runs = [];
    for (let r = 0; r <= reps; r++) runs.push(measure(text)); // first is warm-up
    const m = {
      kb: (runs[0].bytes / 1024).toFixed(1),
      parse: median(runs.map((x) => x.parse)),
      analyze: median(runs.map((x) => x.analyze)),
      diagnostics: median(runs.map((x) => x.diagnostics)),
      total: median(runs.map((x) => x.total)),
      diags: runs[0].diags,
      clean: runs.every((x) => x.ok),
    };
    rows.push(m);
    if (!m.clean) console.error(`NOTE: ${m.kb} KB document did not analyze error-free`);
  }
  const head = ['KB', 'parse ms', 'analyze ms', 'diagnostics ms', 'total ms', 'diags', 'clean'];
  const fmt = (r) => [r.kb, r.parse.toFixed(1), r.analyze.toFixed(1), r.diagnostics.toFixed(1), r.total.toFixed(1), r.diags, r.clean ? 'yes' : 'NO'];
  const table = [head, ...rows.map(fmt)];
  const widths = head.map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
  for (const row of table) console.log(row.map((c, i) => String(c).padEnd(widths[i] + 2)).join(''));
  const bad = process.env.ESQL_LSP_NO_GRAMMAR ? false : !grammarReady();
  if (bad) {
    console.error('\ngrammar was expected but is NOT loaded — re-run after npm ci, or attribute the table to heuristic mode.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
