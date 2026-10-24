'use strict';
/**
 * T-CACHE: the server keeps a ONE-entry parse cache keyed by text. With more
 * than one document open (the normal case), does every request pay a full
 * parse? Measure through a real stdio session.
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
const root = corpusDir(process.argv.slice(2));

// The three files the round-2 numbers came from, when this corpus has them;
// otherwise the three largest files it does have (the point is big files).
let picks = [
  '_from-archives/Healthcare/Healthcare/transport/TransportSender.esql',
  '_from-archives/Healthcare/Healthcare/healthcare/Receiver.esql',
  'Paymob-Payment-Gateway-Integration/PaymobIntegrationApp/PaymentInit_BuildPaymentKeyRequest.esql',
].map((p) => path.join(root, p)).filter((p) => fs.existsSync(p));
if (picks.length < 3) {
  picks = findFiles(root)
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)
    .slice(0, 3);
}

class C {
  constructor() {
    this.child = spawn('node', [SERVER, '--stdio'], { env: process.env });
    this.buf = Buffer.alloc(0); this.id = 1; this.p = new Map();
    this.child.stdout.on('data', (d) => this.feed(d));
    this.child.stderr.on('data', () => {});
  }
  send(m) { const b = JSON.stringify(m); this.child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`); }
  notify(m, p) { this.send({ jsonrpc: '2.0', method: m, params: p }); }
  req(m, p) { const id = this.id++; return new Promise((res) => { this.p.set(id, res); this.send({ jsonrpc: '2.0', id, method: m, params: p }); }); }
  feed(ch) {
    this.buf = Buffer.concat([this.buf, ch]);
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n');
      if (h < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, h).toString('ascii'));
      if (!m) return;
      const len = Number(m[1]);
      if (this.buf.length < h + 4 + len) return;
      const body = this.buf.subarray(h + 4, h + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(h + 4 + len);
      const msg = JSON.parse(body);
      if (msg.id !== undefined && this.p.has(msg.id)) {
        const res = this.p.get(msg.id);
        this.p.delete(msg.id);
        res(msg.result);
      }
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new C();
  await c.req('initialize', { processId: process.pid, rootUri: null, capabilities: { textDocument: { hover: {}, completion: { completionItem: {} } } }, initializationOptions: {} });
  c.notify('initialized', {});
  await sleep(6000); // let the grammar load
  const uris = picks.map((p) => 'file://' + p);
  picks.forEach((p, i) => c.notify('textDocument/didOpen', { textDocument: { uri: uris[i], languageId: 'esql', version: 1, text: fs.readFileSync(p, 'utf8') } }));
  await sleep(1500);

  // a position that hovers something in every file: line 0-ish, first module name
  const posOf = (uri) => {
    const text = fs.readFileSync(uri.slice(7), 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /CREATE COMPUTE MODULE\s+(\S+)/.exec(lines[i]);
      if (m) return { line: i, character: lines[i].indexOf(m[1]) + 1 };
    }
    return { line: 0, character: 1 };
  };
  const pts = uris.map((u) => ({ textDocument: { uri: u }, position: posOf(u) }));

  async function timed(req, label, n) {
    const t = [];
    for (let i = 0; i < n; i++) { const t0 = process.hrtime.bigint(); await req(i); t.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    t.sort((a, b) => a - b);
    return { label, median: +t[Math.floor(n / 2)].toFixed(2), p95: +t[Math.floor(n * 0.95)].toFixed(2), mean: +(t.reduce((a, b) => a + b) / n).toFixed(2) };
  }

  const same = await timed(async () => c.req('textDocument/hover', pts[0]), `hover ${path.basename(picks[0])} 20× in a row`, 20);
  let k = 0;
  const alt = await timed(async () => c.req('textDocument/hover', pts[k++ % uris.length]), `hover alternating across ${uris.length} open documents`, 21);
  const compSame = await timed(async () => c.req('textDocument/completion', { textDocument: { uri: uris[0] }, position: { line: 6, character: 12 } }), 'completion, same document 20×', 20);
  let j = 0;
  const compAlt = await timed(async () => c.req('textDocument/completion', { textDocument: { uri: uris[j++ % uris.length] }, position: { line: 6, character: 12 } }), 'completion alternating across the same 3 documents', 21);
  console.table([same, alt, compSame, compAlt]);
  console.log(`files: ${picks.map((p) => `${path.basename(p)} (${fs.statSync(p).size}B)`).join(', ')}`);
  await c.req('shutdown', null); c.notify('exit', null); await sleep(200);
  process.exit(0);
})();
