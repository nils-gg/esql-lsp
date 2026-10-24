#!/usr/bin/env node
/**
 * Round-2 corpus probe: the surfaces the first audit did not exercise.
 *
 *  phase bulk   — open EVERY file in one session (the "restore a session" case)
 *                 and check every document publishes diagnostics.
 *  phase feat   — per file, in one session: protocol invariants on diagnostics
 *                 and documentSymbol, references monotonicity, semantic-token
 *                 stream validation, completion, robustness (unopened URI,
 *                 out-of-range positions), and latency.
 *  phase edit   — per file: didChange (incremental) inserting a statement, then
 *                 verify the analysis actually moved, then restore the text and
 *                 verify the baseline comes back (parse-cache invalidation).
 *
 *  node scripts/probe/corpus-probe.js --corpus <dir> --out <json> [--mode grammar|heuristic]
 *                   [--phases bulk,feat,edit] [--only <regex>] [--limit N]
 *
 * Records VIOLATIONS (invariant broken) rather than opinions, plus aggregates.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
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
const corpus = corpusDir();
const outFile = path.resolve(arg('out', 'r2.json'));
const mode = arg('mode', 'grammar');
const phases = (arg('phases', 'bulk,feat,edit') || '').split(',');
const only = arg('only', '') ? new RegExp(arg('only')) : null;
const limit = Number(arg('limit', 0));
const hold = Number(arg('hold', 800));
const bootMs = Number(arg('boot', mode === 'heuristic' ? 2500 : 6000));
const REQ_TIMEOUT = Number(arg('reqTimeout', 15000));

function findFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.esql$/i.test(e.name)) out.push(p);
    }
  })(dir);
  out.sort();
  return only ? out.filter((p) => only.test(path.relative(dir, p))) : out;
}

class Client {
  constructor(env) {
    this.child = spawn('node', [SERVER, '--stdio'], { env: { ...process.env, ...env } });
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.published = new Map(); // uri -> {diagnostics, at}
    this.errors = []; // JSON-RPC error responses
    this.stderr = [];
    this.child.stderr.on('data', (d) => this.stderr.push(String(d).trim()));
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.on('exit', (code, sig) => { this.diedEarly = { code, sig }; });
  }
  send(m) {
    const b = JSON.stringify(m);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(b, 'utf8')}\r\n\r\n${b}`);
  }
  notify(m, p) { this.send({ jsonrpc: '2.0', method: m, params: p }); }
  /** raw request: resolves with the LSP result, or {__timeout}/{__error} */
  request(m, p) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ __timeout: true });
      }, REQ_TIMEOUT);
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: '2.0', id, method: m, params: p });
    });
  }
  /** timed + classified; NOTE: never spread the result, it is often an array */
  async ok(m, p) {
    const t0 = Date.now();
    const r = await this.request(m, p);
    const ms = Date.now() - t0;
    if (r && r.__timeout) return { bad: 'timeout', value: null, ms };
    if (r && r.__error) {
      this.errors.push({ method: m, error: r.__error });
      return { bad: 'rpc-error', value: r.__error, ms };
    }
    return { bad: null, value: r === undefined ? null : r, ms };
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n');
      if (h < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, h).toString('ascii'));
      if (!m) return;
      const len = Number(m[1]);
      if (this.buf.length < h + 4 + len) return;
      const body = this.buf.subarray(h + 4, h + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(h + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve(msg.error ? { __error: msg.error } : msg.result);
      } else if (msg.method === 'textDocument/publishDiagnostics') {
        this.published.set(msg.params.uri, { diagnostics: msg.params.diagnostics, at: Date.now() });
      }
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (c) => (c.contents ? (typeof c.contents === 'string' ? c.contents : c.contents.value) : null);

/** LSP: start <= end, and both inside the document (clients clamp, we want truth). */
function badRange(r, lines) {
  if (!r || !r.start || !r.end) return 'malformed';
  if (r.start.line < 0 || r.end.line < 0) return 'negative line';
  if (r.start.line > r.end.line) return 'start after end';
  if (r.start.line >= lines.length || r.end.line >= lines.length) return 'line past EOF';
  if (r.start.character < 0 || r.end.character < 0) return 'negative character';
  const sl = lines[r.start.line] || '';
  const el = lines[r.end.line] || '';
  if (r.start.character > sl.length) return `start char ${r.start.character} past line len ${sl.length}`;
  if (r.end.character > el.length) return `end char ${r.end.character} past line len ${el.length}`;
  if (r.start.line === r.end.line && r.end.character < r.start.character) return 'end char before start char';
  return null;
}
const contains = (outer, inner) =>
  outer.start.line < inner.start.line ||
  (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)
  ? (outer.end.line > inner.end.line ||
     (outer.end.line === inner.end.line && outer.end.character >= inner.end.character))
  : false;

function positionsOf(lines) {
  /** Completion / hover positions derived from what the file actually contains. */
  const p = {};
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trimStart();
    if (!p.setEmpty && /^SET\s+\S+.*;$/.test(t)) p.setEmpty = { line: i, character: l.length };
    if (!p.afterDot && /OutputRoot\.[A-Za-z]/.test(l)) p.afterDot = { line: i, character: l.search(/OutputRoot\./) + 'OutputRoot.'.length };
    if (!p.stmtStart && /^\s*BEGIN\s*$/i.test(l)) p.stmtStart = { line: i + 1, character: (lines[i + 1] || '').match(/^\s*/)[0].length };
    if (!p.insideName && /\bDECLARE\s+([A-Za-z_][A-Za-z0-9_]*)/.test(l)) {
      const m = /\bDECLARE\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(l);
      p.insideName = { line: i, character: m.index + 'DECLARE '.length + 1 };
      p.declaredName = m[1];
    }
    if (!p.inComment && /^\s*--/.test(l)) p.inComment = { line: i, character: l.length - 1 };
    if (!p.inString && /'[^']+'/.test(l)) p.inString = { line: i, character: l.indexOf("'") + 2 };
  }
  return p;
}

(async () => {
  const all = findFiles(corpus);
  const files = limit > 0 ? all.slice(0, limit) : all;
  const legend = mode === 'grammar' ? null : null; // filled from initialize
  const result = { mode, corpus, started: new Date().toISOString(), files: {}, aggregate: {}, fatal: [] };
  const V = (rel, tag, detail) => {
    const e = (result.files[rel] = result.files[rel] || { violations: [] });
    e.violations.push({ tag, detail });
  };

  // ── phase bulk: everything open in one session ─────────────────────────────
  if (phases.includes('bulk')) {
    const c = new Client({ ESQL_LSP_NO_GRAMMAR: mode === 'heuristic' ? '1' : '' });
    const init = await c.ok('initialize', {
      processId: process.pid, rootUri: null,
      capabilities: {
        textDocument: {
          publishDiagnostics: {}, hover: {}, definition: {}, references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          completion: { completionItem: { snippetSupport: true } },
          semanticTokens: { requests: { full: true } },
        },
        workspace: { semanticTokens: { refreshSupport: false } },
      },
      initializationOptions: {},
    });
    if (init.bad) result.fatal.push({ phase: 'bulk', bad: init.bad });
    const caps = (init.value && init.value.capabilities) || {};
    result.capabilities = caps;
    c.notify('initialized', {});
    const t0 = Date.now();
    for (const abs of files) {
      c.notify('textDocument/didOpen', {
        textDocument: { uri: 'file://' + abs, languageId: 'esql', version: 1, text: fs.readFileSync(abs, 'utf8') },
      });
    }
    const openedAt = Date.now();
    await sleep(Math.max(bootMs, 4000) + files.length * 5);
    let silent = [];
    for (const abs of files) {
      const uri = 'file://' + abs;
      const p = c.published.get(uri);
      if (!p) silent.push(path.relative(corpus, abs));
      else {
        const rel = path.relative(corpus, abs);
        const e = (result.files[rel] = result.files[rel] || { violations: [] });
        e.bulk = { count: p.diagnostics.length, latencyMs: p.at - openedAt };
      }
    }
    result.aggregate.bulk = {
      files: files.length,
      published: files.length - silent.length,
      silent,
      slowestLatencyMs: Math.max(0, ...Object.values(result.files).map((f) => (f.bulk ? f.bulk.latencyMs : 0))),
      tookMs: Date.now() - t0,
    };
    await c.ok('shutdown', null);
    c.notify('exit', null);
    await sleep(300);
    if (c.diedEarly) result.fatal.push({ phase: 'bulk', diedEarly: c.diedEarly });
    if (c.errors.length) result.fatal.push({ phase: 'bulk', rpcErrors: c.errors.slice(0, 6) });
    if (c.stderr.length) result.bulkStderrTail = c.stderr.slice(-4);
  }

  // ── phase feat + edit: one document at a time, full surface ────────────────
  if (phases.includes('feat') || phases.includes('edit')) {
    const c = new Client({ ESQL_LSP_NO_GRAMMAR: mode === 'heuristic' ? '1' : '' });
    const init = await c.ok('initialize', {
      processId: process.pid, rootUri: null,
      capabilities: {
        textDocument: {
          publishDiagnostics: {}, hover: {}, definition: {}, references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          completion: { completionItem: { snippetSupport: true } },
          semanticTokens: { requests: { full: true } },
        },
      },
      initializationOptions: {},
    });
    const caps = (init.value && init.value.capabilities) || {};
    const tokenLegend = caps.semanticTokensProvider && caps.semanticTokensProvider.legend;
    c.notify('initialized', {});
    await sleep(bootMs);

    const lat = { total: 0, n: 0, worst: [] };
    const bumpLat = (m, ms) => {
      lat.total += ms; lat.n++;
      if (ms > 250) lat.worst.push({ method: m, ms });
    };

    for (const abs of files) {
      const rel = path.relative(corpus, abs);
      const text = fs.readFileSync(abs, 'utf8');
      const lines = text.split(/\r?\n/);
      const uri = 'file://' + abs;
      const e = (result.files[rel] = result.files[rel] || { violations: [] });
      e.lines = lines.length;
      e.bytes = Buffer.byteLength(text);

      c.published.delete(uri);
      c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'esql', version: 1, text } });
      await sleep(hold);
      const pub = c.published.get(uri);
      e.published = !!pub;

      // (A) diagnostics protocol invariants
      for (const d of (pub && pub.diagnostics) || []) {
        const br = badRange(d.range, lines);
        if (br) V(rel, 'DIAG-RANGE', `${br} :: ${d.message.slice(0, 48)} @ ${d.range && d.range.start.line}:${d.range.start.character}`);
        if (!d.message || !d.message.trim()) V(rel, 'DIAG-EMPTY-MESSAGE', JSON.stringify(d).slice(0, 80));
        if (d.severity === undefined || d.severity < 1 || d.severity > 4) V(rel, 'DIAG-SEVERITY', JSON.stringify(d.severity));
        if (!d.source) V(rel, 'DIAG-NO-SOURCE', d.message.slice(0, 40));
      }

      // (B) documentSymbol invariants
      const sym = await c.ok('textDocument/documentSymbol', { textDocument: { uri } });
      bumpLat('documentSymbol', sym.ms);
      const flat = [];
      (function walk(list, parent, depth) {
        for (const s of list || []) {
          flat.push({ s, parent, depth });
          walk(s.children, s, depth + 1);
        }
      })(sym.value || [], null, 0);
      e.symbols = flat.length;
      for (const { s, parent } of flat) {
        const sel = s.selectionRange, rg = s.range;
        if (!sel || !rg) { V(rel, 'SYM-MISSING-RANGE', `${s.name}`); continue; }
        if (!contains(rg, sel)) V(rel, 'SYM-SEL-NOT-IN-RANGE', `${s.name}: sel ${sel.start.line}:${sel.start.character}-${sel.end.line}:${sel.end.character} not inside ${rg.start.line}:${rg.start.character}-${rg.end.line}:${rg.end.character}`);
        if ((lines[sel.start.line] || '').substring(sel.start.character, sel.end.character) !== s.name) {
          V(rel, 'SYM-SEL-TEXT', `${s.name} @${sel.start.line}:${sel.start.character} -> ${JSON.stringify((lines[sel.start.line] || '').substring(sel.start.character, sel.end.character))}`);
        }
        const br = badRange(rg, lines); if (br) V(rel, 'SYM-RANGE', `${br} :: ${s.name}`);
        if (rg.end.line - rg.start.line > 50 && flat.length && false) void 0;
        if (parent && !contains(parent.range, s.range)) V(rel, 'SYM-CHILD-OUTSIDE-PARENT', `${parent.name} > ${s.name}`);
        if (!s.name || !s.name.trim()) V(rel, 'SYM-EMPTY-NAME', JSON.stringify(s).slice(0, 60));
      }

      // (C) references monotonicity + hover/definition ranges at every symbol
      let defFound = 0, refFound = 0, hoverFound = 0;
      for (const { s } of flat.slice(0, mode === 'grammar' ? flat.length : flat.length)) {
        const at = { line: s.selectionRange.start.line, character: s.selectionRange.start.character + Math.floor(s.name.length / 2) };
        const p = { textDocument: { uri }, position: at };
        const d = await c.ok('textDocument/definition', p); bumpLat('definition', d.ms);
        const r1 = await c.ok('textDocument/references', { ...p, context: { includeDeclaration: true } }); bumpLat('references', r1.ms);
        const r0 = await c.ok('textDocument/references', { ...p, context: { includeDeclaration: false } }); bumpLat('references', r0.ms);
        const h = await c.ok('textDocument/hover', p); bumpLat('hover', h.ms);
        if (Array.isArray(d.value) ? d.value.length : d.value) defFound++;
        const n1 = (r1.value || []).length, n0 = (r0.value || []).length;
        if (n1) refFound++;
        if (n0 > n1) V(rel, 'REFS-NOT-MONOTONIC', `${s.name}: includeDeclaration=false gave ${n0}, true gave ${n1}`);
        for (const loc of [...(r1.value || []), ...(Array.isArray(d.value) ? d.value : d.value ? [d.value] : [])]) {
          const br = badRange(loc.range, lines);
          if (br) V(rel, 'NAV-RANGE', `${br} :: ${s.name} -> ${loc.range.start.line}:${loc.range.start.character}`);
          if (loc.uri && loc.uri !== uri) V(rel, 'NAV-FOREIGN-URI', `${s.name} -> ${loc.uri}`);
        }
        if (h.value && textOf(h.value)) hoverFound++;
        if (h.value && h.value.range) {
          const br = badRange(h.value.range, lines);
          if (br) V(rel, 'HOVER-RANGE', `${br} :: ${s.name}`);
        }
      }
      e.featureAnswers = { symbols: flat.length, defFound, refFound, hoverFound };

      // (D) completion at positions the file really offers
      const pos = positionsOf(lines);
      const comp = {};
      for (const key of ['stmtStart', 'setEmpty', 'afterDot', 'insideName']) {
        if (!pos[key]) continue;
        const r = await c.ok('textDocument/completion', { textDocument: { uri }, position: pos[key] });
        bumpLat('completion', r.ms);
        const items = Array.isArray(r.value) ? r.value : (r.value && r.value.items) || [];
        const labels = items.map((i) => i.label);
        const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
        comp[key] = { count: items.length, sample: labels.slice(0, 6) };
        if (r.bad) V(rel, 'COMPLETION-' + key, r.bad);
        if (dupes.length) V(rel, 'COMPLETION-DUPES', `${key}: ${[...new Set(dupes)].slice(0, 6).join(', ')}`);
        for (const it of items) {
          if (!it.label) V(rel, 'COMPLETION-EMPTY-LABEL', JSON.stringify(it).slice(0, 60));
          if (it.textEdit) {
            const br = badRange(it.textEdit.range, lines);
            if (br) V(rel, 'COMPLETION-EDIT-RANGE', `${key}: ${br} :: ${it.label}`);
          }
        }
      }
      e.completion = comp;

      // (E) semantic tokens (grammar mode only has data)
      const st = await c.ok('textDocument/semanticTokens/full', { textDocument: { uri } });
      bumpLat('semanticTokens', st.ms);
      const data = (st.value && st.value.data) || [];
      e.tokenCount = Math.floor(data.length / 5);
      if (data.length % 5 !== 0) V(rel, 'TOKENS-LENGTH%5', String(data.length));
      if (tokenLegend) {
        let line = 0, col = 0, prevLineOnStream = -1;
        const badTok = [];
        for (let i = 0; i + 4 < data.length; i += 5) {
          const [dl, dc, len, t, mods] = data.slice(i, i + 5);
          line += dl; col = dl === 0 ? col + dc : dc;
          if (t < 0 || t >= tokenLegend.tokenTypes.length) badTok.push(`typeIndex ${t} not in legend`);
          if (mods !== 0 && !(tokenLegend.tokenModifiers || []).length) badTok.push('modifier bits with empty modifier legend');
          if (line < 0 || col < 0 || len < 0) badTok.push(`negative delta at #${i}`);
          if (line > lines.length) badTok.push(`line ${line} past EOF (doc has ${lines.length})`);
          const src = lines[line] || '';
          if (col + len > src.length) badTok.push(`token ${tokenLegend.tokenTypes[t] || t} at ${line}:${col}+${len} past line len ${src.length}`);
          if (line < prevLineOnStream) badTok.push(`stream not ascending at #${i}`);
          prevLineOnStream = line;
          if (badTok.length > 4) break;
        }
        for (const b of badTok) V(rel, 'TOKENS-STREAM', b);
        const counts = {};
        for (let i = 0; i + 4 < data.length; i += 5) {
          const nm = tokenLegend.tokenTypes[data[i + 3]];
          if (nm) counts[nm] = (counts[nm] || 0) + 1;
        }
        e.tokenTypes = counts;
      }

      // (F) robustness: unopened URI + out-of-range positions
      const GHOST = 'file:///esql-lsp-probe/never-opened.esql';
      for (const [m, extra] of [
        ['textDocument/documentSymbol', {}],
        ['textDocument/hover', { position: { line: 0, character: 0 } }],
        ['textDocument/definition', { position: { line: 0, character: 0 } }],
        ['textDocument/references', { position: { line: 0, character: 0 }, context: { includeDeclaration: true } }],
        ['textDocument/completion', { position: { line: 0, character: 0 } }],
        ['textDocument/semanticTokens/full', {}],
      ]) {
        const r = await c.ok(m, { textDocument: { uri: GHOST }, ...extra });
        bumpLat(m, r.ms);
        if (r.bad) V(rel, 'GHOST-URI-' + m.split('/')[1], r.bad);
        const empty = r.value === null || r.value === undefined
          || (Array.isArray(r.value) && r.value.length === 0)
          || (r.value && Array.isArray(r.value.data) && r.value.data.length === 0);
        if (!r.bad && !empty) V(rel, 'GHOST-URI-ANSWERED', `${m} answered for a document that was never opened: ${JSON.stringify(r.value).slice(0, 60)}`);
      }
      for (const [label, position] of [
        ['line-past-eof', { line: lines.length + 500, character: 0 }],
        ['char-past-eol', { line: 0, character: 99999 }],
        ['negative-line', { line: -1, character: 0 }],
        ['negative-char', { line: 0, character: -5 }],
      ]) {
        for (const m of ['textDocument/hover', 'textDocument/definition', 'textDocument/references', 'textDocument/completion']) {
          const r = await c.ok(m, {
            textDocument: { uri }, position,
            ...(m === 'textDocument/references' ? { context: { includeDeclaration: true } } : {}),
          });
          bumpLat(m, r.ms);
          if (r.bad) {
            // A negative line/character is not a position at all. Since the
            // I-22.4 fix the server answers InvalidParams (-32602) rather than
            // inventing an answer for it, which is protocol-legal: accept that,
            // and accept an empty answer; anything else is a violation.
            const code = r.bad === 'rpc-error' && r.value ? r.value.code : undefined;
            const answeredInvalid = label.startsWith('negative') && code === -32602;
            if (!answeredInvalid) {
              V(rel, 'BOUNDS-' + label, `${m.split('/')[1]}: ${r.bad}${code ? ' code=' + code : ''}`);
            }
          }
        }
      }

      // (G) incremental didChange: analysis must move, and restore must restore
      if (phases.includes('edit')) {
        const anchor = lines.findIndex((l) => /^\s*BEGIN\s*$/i.test(l));
        const at = anchor >= 0 ? anchor + 1 : 0;
        const indent = anchor >= 0 ? (lines[at] || '').match(/^\s*/)[0] : '';
        const probeLine = `${indent}SET r2ProbeUndeclared = 1;\n`;
        const before = JSON.stringify(e.featureAnswers);
        c.notify('textDocument/didChange', {
          textDocument: { uri, version: 2 },
          contentChanges: [{ range: { start: { line: at, character: 0 }, end: { line: at, character: 0 } }, text: probeLine }],
        });
        await sleep(hold);
        const pub2 = c.published.get(uri);
        const msgs = ((pub2 && pub2.diagnostics) || []).map((d) => d.message);
        e.edit = {
          at,
          diagCount: (pub2 && pub2.diagnostics.length) || 0,
          mentionsProbe: msgs.some((m) => /r2ProbeUndeclared/.test(m)),
        };
        const syms2 = await c.ok('textDocument/documentSymbol', { textDocument: { uri } });
        const n2 = JSON.stringify(syms2.value || []).length;
        e.edit.symbolJsonLenAfterEdit = n2;
        const lenBefore = JSON.stringify(sym.value || []).length;
        // same outline apart from the inserted line shifting: the *names* must match
        const names2 = [];
        (function walk(l) { for (const s of l || []) { names2.push(s.name); walk(s.children); } })(syms2.value || []);
        const names1 = flat.map((f) => f.s.name);
        if (JSON.stringify(names2) !== JSON.stringify(names1)) {
          V(rel, 'EDIT-OUTLINE-CHANGED', `inserting one SET changed the outline: -${names1.filter((n) => !names2.includes(n)).join(',')} +${names2.filter((n) => !names1.includes(n)).join(',')}`);
        }
        // hover on the inserted name must now work (the edit really reached the analysis)
        const hv = await c.ok('textDocument/hover', { textDocument: { uri }, position: { line: at, character: indent.length + 4 } });
        e.edit.hoverOnInserted = !!(hv.value && textOf(hv.value));
        // restore
        c.notify('textDocument/didChange', {
          textDocument: { uri, version: 3 },
          contentChanges: [{ range: { start: { line: at, character: 0 }, end: { line: at + 1, character: 0 } }, text: '' }],
        });
        await sleep(hold);
        const pub3 = c.published.get(uri);
        e.edit.diagCountRestored = (pub3 && pub3.diagnostics.length) || 0;
        const syms3 = await c.ok('textDocument/documentSymbol', { textDocument: { uri } });
        const names3 = [];
        (function walk(l) { for (const s of l || []) { names3.push(s.name); walk(s.children); } })(syms3.value || []);
        if (JSON.stringify(names3) !== JSON.stringify(names1)) V(rel, 'EDIT-RESTORE-FAILED', `outline after restoring the text differs: ${JSON.stringify(names3).slice(0, 80)} vs ${JSON.stringify(names1).slice(0, 80)}`);
        e.edit.baselineAnswers = before;
      }

      c.notify('textDocument/didClose', { textDocument: { uri } });
      await sleep(120);
      process.stderr.write(`${e.symbols}s/${e.tokenCount}t `);
    }
    result.aggregate.feat = {
      avgRequestMs: +(lat.total / Math.max(1, lat.n)).toFixed(1),
      requests: lat.n,
      slowRequests: lat.worst.sort((a, b) => b.ms - a.ms).slice(0, 12),
      tokenLegend: tokenLegend && tokenLegend.tokenTypes,
    };
    if (c.diedEarly) result.fatal.push({ phase: 'feat', diedEarly: c.diedEarly });
    if (c.errors.length) result.fatal.push({ phase: 'feat', rpcErrors: c.errors.slice(0, 8) });
    if (c.stderr.length) result.featStderrTail = c.stderr.slice(-4);
    await c.ok('shutdown', null);
    c.notify('exit', null);
    await sleep(200);
  }

  // aggregates over violations
  const byTag = {};
  for (const [f, e] of Object.entries(result.files)) {
    for (const v of e.violations || []) {
      const g = (byTag[v.tag] = byTag[v.tag] || { files: new Set(), count: 0, examples: [] });
      g.files.add(f); g.count++;
      if (g.examples.length < 4) g.examples.push({ file: f, detail: v.detail });
    }
  }
  result.violationSummary = Object.entries(byTag)
    .map(([tag, g]) => ({ tag, files: g.files.size, count: g.count, examples: g.examples }))
    .sort((a, b) => b.count - a.count);
  result.aggregate.totals = {
    files: files.length,
    filesWithViolations: Object.values(result.files).filter((f) => (f.violations || []).length).length,
    violations: Object.values(result.files).reduce((n, f) => n + (f.violations || []).length, 0),
  };
  result.finished = new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
  console.log(`\nwrote ${outFile}`);
  for (const v of result.violationSummary) console.log(`  ${String(v.count).padStart(5)}  ${v.tag}  (${v.files} files)`);
  process.exit(0);
})().catch((e) => { console.error('corpus-probe failed:', e && e.stack ? e.stack : e); process.exit(1); });
