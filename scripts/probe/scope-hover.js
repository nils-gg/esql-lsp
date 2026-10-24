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
/**
 * FINAL scope measurement for the ISSUES.md write-up: for every name declared
 * in two or more distinct scopes, probe one use inside each scope and compare
 * hover / definition against the declaration that is really in scope.
 */
const { initGrammar, parse, analyzeDocument } = DIST('src/parser');
const { hoverAt } = DIST('src/hover');
const { definitionAt } = DIST('src/definitions');
const { scan } = DIST('src/scanner');
const root = corpusDir(process.argv.slice(2));
const files = [];
(function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (p.endsWith('.esql')) files.push(p); } })(root);
const maskedAt = (masked, line, idx) => { const l = masked[line] || ''; const c = l[idx]; return c === undefined || c === ' '; };
const declaresAt = (decls, line, idx) => decls.some((d) => d.range.start.line === line && idx >= d.range.start.character - 1 && idx <= d.range.end.character + 1);
const one = (h) => (h ? (typeof h.contents === 'string' ? h.contents : h.contents.value).replace(/\n+/g, ' | ') : null);
const routineAt = (rs, line) => {
  const span = (r) => r.declRange || r.range;
  const hit = rs.filter((r) => span(r).start.line <= line && span(r).end.line >= line);
  hit.sort((a, b) => span(a).start.line - span(b).start.line);
  return hit.length ? hit[hit.length - 1].name : '(module)';
};

(async () => {
  await initGrammar();
  let names = 0, probes = 0, hoverOwnerWrong = 0, hoverTypeWrong = 0, defExact = 0, defMulti = 0, defOther = 0;
  const rows = [], defRows = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const tree = parse(text); if (!tree) continue;
    const doc = analyzeDocument(tree);
    const lines = text.split(/\r?\n/);
    const masked = scan(text).lines;
    const byName = new Map();
    for (const d of doc.declaredNames) { const k = d.name.toUpperCase(); (byName.get(k) || byName.set(k, []).get(k)).push(d); }
    for (const [name, decls] of byName) {
      if (decls.length < 2) continue;
      if (new Set(decls.map((d) => `${d.scope.start.line}:${d.scope.end.line}`)).size < 2) continue;
      names++;
      const re = new RegExp(`(?<![A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`, 'gi');
      for (const own of decls) {
        let use = null;
        for (let i = own.scope.start.line; i <= Math.min(own.scope.end.line, lines.length - 1); i++) {
          if (/^\s*(DECLARE|--)/i.test(lines[i])) continue;
          re.lastIndex = 0; let m;
          while ((m = re.exec(lines[i]))) {
            if (i === own.range.start.line) continue;
            if (maskedAt(masked, i, m.index)) continue;          // inside a string/comment: correctly un-answerable
            if (declaresAt(doc.declaredNames, i, m.index)) continue;  // the position IS a declaration (e.g. a parameter)
            use = { line: i, ch: m.index + 1 }; break;
          }
          if (use) break;
        }
        if (!use) continue;
        probes++;
        const hv = one(hoverAt(text, use.line, use.ch, doc));
        const shown = hv && /\*\*.*?\*\*(?: — `([^`]*)`)?/.exec(hv);
        const shownType = shown && shown[1] !== undefined ? shown[1] : null;
        const ownType = (own.detail || '').replace(/^parameter\s*/i, '').toUpperCase();
        const owner = hv && /in `([^`]+)`/.exec(hv);
        const truth = routineAt(doc.routines, use.line);
        const hoverRoutine = owner ? owner[1].replace(/\(\)$/, '') : null;
        const ow = hoverRoutine !== null && hoverRoutine !== truth;
        const d = definitionAt(text, use.line, use.ch, doc);
        const exact = d.length === 1 && d[0].start.line === own.range.start.line && d[0].start.character === own.range.start.character;
        const tw = shownType !== null && ownType && shownType !== ownType;
        if (ow) hoverOwnerWrong++;
        if (tw) hoverTypeWrong++;
        if (exact) defExact++; else if (d.length > 1) defMulti++; else defOther++;
        if (!exact) defRows.push({ f: path.relative(root, f), name, use: `${use.line + 1}:${use.ch}`, want: `${own.range.start.line + 1}:${own.range.start.character}`, def: d.map((x) => `${x.start.line + 1}:${x.start.character}`).join(',') || 'none' });
        if (ow || tw) rows.push({ f: path.relative(root, f), name, use: `${use.line + 1}:${use.ch}`, truth, hover: hoverRoutine, hoverType: shownType, ownType, def: d.map((x) => `${x.start.line + 1}:${x.start.character}`).join(',') || 'none' });
      }
    }
  }
  console.log(`names declared in ≥2 distinct scopes : ${names}`);
  console.log(`use-site probes                     : ${probes}`);
  console.log(`  hover named the wrong routine     : ${hoverOwnerWrong}`);
  console.log(`  hover showed the wrong type       : ${hoverTypeWrong}`);
  console.log(`  definition = the in-scope decl    : ${defExact}`);
  console.log(`  definition returned several       : ${defMulti}`);
  console.log(`  definition returned elsewhere     : ${defOther}`);
  console.log('\nwrong-hover cases:');
  console.log('\nnot-exact definitions:');
  for (const r of defRows) console.log(`  ${r.f} :: ${r.name} @${r.use} — want ${r.want}, got ${r.def}`);
  console.log('\nwrong-hover cases:');
  for (const r of rows) console.log(`  ${r.f} :: ${r.name} @${r.use} — in \`${r.truth}\`, hover \`${r.hover}\`${r.hoverType && r.ownType && r.hoverType !== r.ownType ? `, hover type \`${r.hoverType}\` vs in-scope \`${r.ownType}\`` : ''}; definition → ${r.def}`);
})();
