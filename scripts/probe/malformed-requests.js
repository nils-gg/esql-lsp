'use strict';
/**
 * T-MALFORMED: protocol robustness the corpus probe does not exercise —
 * requests before/without initialize, unknown methods, wrong-shaped params,
 * $/cancelRequest, a second initialize, double didOpen, and partial settings.
 * A server should answer with an error response, never die or hang.
 */
const { spawn } = require('child_process');
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
const findFiles = (dir) => {
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
  return out;
};
const SRC = (() => {
  const given = arg('file', '');
  if (given) return path.resolve(given);
  // Any real file will do; the first one is deterministic (findFiles sorts).
  const first = findFiles(corpusDir(process.argv.slice(2)))[0];
  if (!first) { console.error('no .esql file under --corpus'); process.exit(2); }
  return first;
})();
const text = fs.readFileSync(SRC, 'utf8');

class C {
  constructor(env) {
    this.child = spawn('node', [SERVER, '--stdio'], { env: { ...process.env, ...(env || {}) } });
    this.buf = Buffer.alloc(0); this.id = 1; this.p = new Map(); this.notes = [];
    this.child.stdout.on('data', (d) => this.feed(d));
    this.stderr = [];
    this.child.stderr.on('data', (d) => this.stderr.push(String(d).trim()));
    this.child.on('exit', (code, sig) => this.notes.push(`EXIT code=${code} sig=${sig}`));
  }
  send(m) { const b = JSON.stringify(m); this.child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`); }
  notify(m, p) { this.send({ jsonrpc: '2.0', method: m, params: p }); }
  req(m, p) { const id = this.id++; return new Promise((r) => { const t = setTimeout(() => { this.p.delete(id); r({ __timeout: true }); }, 8000); this.p.set(id, { r, t }); this.send({ jsonrpc: '2.0', id, method: m, params: p }); }); }
  feed(ch) {
    this.buf = Buffer.concat([this.buf, ch]);
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n'); if (h < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, h).toString('ascii')); if (!m) return;
      const len = Number(m[1]); if (this.buf.length < h + 4 + len) return;
      const body = buf_body(this.buf, h, len); this.buf = this.buf.subarray(h + 4 + len);
      let msg; try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id !== undefined && this.p.has(msg.id)) {
        const { r, t } = this.p.get(msg.id); clearTimeout(t); this.p.delete(msg.id);
        r(msg.error ? { __error: msg.error.code + ' ' + msg.error.message } : msg.result);
        continue;
      }
      if (msg.method === 'textDocument/publishDiagnostics') this.lastPub = msg.params.diagnostics;
    }
  }
}
function buf_body(b, h, len) { return b.subarray(h + 4, h + 4 + len).toString('utf8'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (r) => (r && r.__timeout ? 'TIMEOUT' : r && r.__error ? 'error ' + r.__error : Array.isArray(r) ? `[${r.length}]` : r === null || r === undefined ? 'null' : typeof r === 'object' ? JSON.stringify(r).slice(0, 60) : String(r));

(async () => {
  // ── before initialize ──────────────────────────────────────────────────────
  {
    const c = new C();
    const r = await c.req('textDocument/hover', { textDocument: { uri: 'file:///x.esql' }, position: { line: 0, character: 0 } });
    console.log('hover BEFORE initialize            ->', brief(r));
    const r2 = await c.req('totally/unknown', {});
    console.log('unknown method BEFORE initialize   ->', brief(r2));
    try { await c.req('shutdown', null); } catch { /* ignore */ }
    c.notify('exit', null); await sleep(300);
    console.log('   stderr:', JSON.stringify(c.stderr.slice(-1)).slice(0, 160), c.notes.join(' '));
  }
  // ── after initialize: junk methods, junk params, lifecycle oddities ────────
  {
    const c = new C();
    await c.req('initialize', { processId: process.pid, rootUri: null, capabilities: { textDocument: { hover: {}, documentSymbol: {}, publishDiagnostics: {}, completion: {}, semanticTokens: { requests: { full: true } } } }, initializationOptions: {} });
    c.notify('initialized', {});
    await sleep(6000);
    const uri = 'file://' + SRC;
    c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'esql', version: 1, text } });
    await sleep(700);
    console.log('\n-- after initialize --');
    console.log('totally/unknown                    ->', brief(await c.req('totally/unknown', {})));
    console.log('hover, no position                 ->', brief(await c.req('textDocument/hover', { textDocument: { uri } })));
    console.log('hover, position as strings         ->', brief(await c.req('textDocument/hover', { textDocument: { uri }, position: { line: '3', character: '4' } })));
    console.log('documentSymbol, uri missing        ->', brief(await c.req('textDocument/documentSymbol', {})));
    console.log('documentSymbol, uri = null         ->', brief(await c.req('textDocument/documentSymbol', { textDocument: { uri: null } })));
    console.log('completion, uri wrong type         ->', brief(await c.req('textDocument/completion', { textDocument: { uri: 42 }, position: { line: 1, character: 1 } })));
    console.log('references, no context             ->', brief(await c.req('textDocument/references', { textDocument: { uri }, position: { line: 3, character: 4 } })));
    console.log('didChange with a nonsense range    -> ', (() => { c.notify('textDocument/didChange', { textDocument: { uri, version: 9 }, contentChanges: [{ range: { start: { line: 9999, character: 9 }, end: { line: 0, character: 0 } }, text: 'BOGUS' }] }); return 'notified'; })());
    await sleep(600);
    console.log('   after that edit, documentSymbol  ->', brief(await c.req('textDocument/documentSymbol', { textDocument: { uri } })));
    console.log('   diagnostics after nonsense edit  ->', JSON.stringify((c.lastPub || []).slice(0, 2)));
    c.notify('$/cancelRequest', { id: 3 });
    console.log('$/cancelRequest accepted           -> yes (notification)');
    console.log('second initialize                  ->', brief((await c.req('initialize', { processId: process.pid, rootUri: null, capabilities: {}, initializationOptions: {} })).capabilities ? 'answered with capabilities' : null).slice(0, 80));
    c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'esql', version: 1, text } });
    console.log('duplicate didOpen                  -> notified');
    await sleep(500);
    console.log('documentSymbol after all that      ->', brief(await c.req('textDocument/documentSymbol', { textDocument: { uri } })));
    console.log('exit clean?', await c.req('shutdown', null).then((r) => brief(r)));
    c.notify('exit', null); await sleep(300);
    console.log('   stderr tail:', JSON.stringify(c.stderr.slice(-2)).slice(0, 220), c.notes.join(' '));
  }
  // ── partial settings: does a one-key override keep the other defaults? ─────
  {
    const c = new C();
    await c.req('initialize', {
      processId: process.pid, rootUri: null,
      capabilities: { textDocument: { publishDiagnostics: {} } },
      initializationOptions: { diagnostics: { undeclaredVariables: false } },
    });
    c.notify('initialized', {});
    await sleep(6000);
    const uri = 'file:///esql-lsp-probe/partial-settings.esql';
    c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'esql', version: 1, text: 'CREATE COMPUTE MODULE M\n  CREATE FUNCTION Main() RETURNS BOOLEAN\n  BEGIN\n    SET nobody = 1;\n    RETURN TRUE;\n  END;\nEND MODULE\n' } });
    await sleep(900);
    console.log('\npartial settings {diagnostics:{undeclaredVariables:false}}:');
    const got = await new Promise(async (res) => {
      c.child.stdout.on('data', () => {});
      setTimeout(() => res(c.lastPub || 'none'), 100);
    });
    console.log('   diagnostics seen:', JSON.stringify((got || []).map((d) => d.message.slice(0, 44))));
    console.log('   (undeclaredVariables off must silence the undeclared warning but KEEP the missing-END-MODULE one)');
    await c.req('shutdown', null); c.notify('exit', null); await sleep(200);
  }
  process.exit(0);
})();
