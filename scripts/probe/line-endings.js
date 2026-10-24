'use strict';
/**
 * T-EOL-SERVER: what does a client actually get for a file whose line endings
 * are not LF? (CRLF is 7 of the 103 corpus files; CR-only is what an EOL
 * conversion accident leaves behind.) Plus: how many completion items does a
 * real file get that are declared outside the cursor's scope?
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
const root = corpusDir(process.argv.slice(2));

class C {
  constructor(mode) {
    this.child = spawn('node', [SERVER, '--stdio'], { env: { ...process.env, ESQL_LSP_NO_GRAMMAR: mode === 'heuristic' ? '1' : '' } });
    this.buf = Buffer.alloc(0); this.id = 1; this.p = new Map(); this.pub = new Map();
    this.child.stdout.on('data', (d) => this.feed(d));
    this.child.stderr.on('data', () => {});
  }
  send(m) { const b = JSON.stringify(m); this.child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`); }
  notify(m, p) { this.send({ jsonrpc: '2.0', method: m, params: p }); }
  req(m, p) {
    const id = this.id++;
    return new Promise((res) => {
      const t = setTimeout(() => { this.p.delete(id); res({ __timeout: true }); }, 15000);
      this.p.set(id, { res, t }); this.send({ jsonrpc: '2.0', id, method: m, params: p });
    });
  }
  feed(ch) {
    this.buf = Buffer.concat([this.buf, ch]);
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n'); if (h < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, h).toString('ascii')); if (!m) return;
      const len = Number(m[1]); if (this.buf.length < h + 4 + len) return;
      const body = this.buf.subarray(h + 4, h + 4 + len).toString('utf8'); this.buf = this.buf.subarray(h + 4 + len);
      const msg = JSON.parse(body);
      if (msg.id !== undefined && this.p.has(msg.id)) { const { res, t } = this.p.get(msg.id); clearTimeout(t); this.p.delete(msg.id); res(msg.error ? { __error: msg.error } : msg.result); }
      else if (msg.method === 'textDocument/publishDiagnostics') this.pub.set(msg.params.uri, msg.params.diagnostics);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flat = (l, o = []) => { for (const s of l || []) { o.push(s); flat(s.children, o); } return o; };

const BASE = [
  'CREATE COMPUTE MODULE EolProbe',
  '  CREATE FUNCTION Main() RETURNS BOOLEAN',
  '  BEGIN',
  '    DECLARE amount CHARACTER;   -- trailing note',
  '    SET amount = LENGTH(amount);',
  '    RETURN TRUE;',
  '  END;',
  'END MODULE;',
  '',
];

(async () => {
  // ── BOM / encoding facts in the corpus ─────────────────────────────────────
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.esql')) files.push(p); } })(root);
  const bom = files.filter((f) => fs.readFileSync(f).slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  const badUtf8 = files.filter((f) => {
    try { new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(f)); return false; } catch { return true; }
  });
  console.log(`corpus: ${files.length} files · UTF-8 BOM: ${bom.length}${bom.length ? ' -> ' + bom.map((f) => path.relative(root, f)).join(', ') : ''}`);
  console.log(`        not valid UTF-8: ${badUtf8.length}${badUtf8.length ? ' -> ' + badUtf8.map((f) => path.relative(root, f)).join(', ') : ''}`);

  for (const mode of ['grammar', 'heuristic']) {
    const c = new C(mode);
    await c.req('initialize', { processId: process.pid, rootUri: null, capabilities: { textDocument: { hover: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, publishDiagnostics: {}, semanticTokens: { requests: { full: true } } } }, initializationOptions: {} });
    c.notify('initialized', {});
    await sleep(mode === 'heuristic' ? 2500 : 6000);
    console.log(`\n=== ${mode} mode: the same file with three line endings ===`);
    for (const [label, eol] of [['LF    ', '\n'], ['CRLF  ', '\r\n'], ['CR only', '\r'], ['LF+BOM', '\n']]) {
      let text = BASE.join(eol);
      if (label === 'LF+BOM') text = '\uFEFF' + BASE.join('\n');
      const uri = `file:///esql-lsp-probe/eol-${label.trim()}.esql`;
      c.pub.delete(uri);
      c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'esql', version: 1, text } });
      await sleep(750);
      const syms = flat(await c.req('textDocument/documentSymbol', { textDocument: { uri } }));
      const diags = c.pub.get(uri) || [];
      const toks = (await c.req('textDocument/semanticTokens/full', { textDocument: { uri } }) || {}).data || [];
      // the client's own view of the file's lines (what VS Code splits on)
      const clientLines = text.split(/\r\n|\n\r|\n|\r/);
      const amount = syms.find((s) => s.name === 'amount');
      const clientLineOfAmount = clientLines.findIndex((l) => /DECLARE amount/.test(l));
      const clientColOfAmount = clientLineOfAmount >= 0 ? clientLines[clientLineOfAmount].indexOf('amount') : -1;
      const hoverAtClientPos = amount ? await c.req('textDocument/hover', { textDocument: { uri }, position: { line: clientLineOfAmount, character: clientColOfAmount + 3 } }) : null;
      console.log(`   ${label}: ${syms.length} symbols [${syms.map((s) => s.name).join(', ')}], ${diags.length} diagnostics, ${Math.floor(toks.length / 5)} tokens` +
        (amount ? `\n       \`amount\` reported at line ${amount.selectionRange.start.line} char ${amount.selectionRange.start.character}; the client's own copy has it at line ${clientLineOfAmount} char ${clientColOfAmount} → ${amount.selectionRange.start.line === clientLineOfAmount && amount.selectionRange.start.character === clientColOfAmount ? 'MATCHES' : 'MISPLACED'}; hover at the client's position: ${hoverAtClientPos && hoverAtClientPos.contents ? 'answers' : 'null'}` : '\n       no `amount` symbol at all'));
      if (diags.length) console.log(`       diagnostics: ${JSON.stringify(diags.map((d) => `${d.message.slice(0, 34)}@${d.range.start.line}:${d.range.start.character}`))}`);
      c.notify('textDocument/didClose', { textDocument: { uri } });
      await sleep(120);
    }
    await c.req('shutdown', null); c.notify('exit', null); await sleep(250);
  }
  process.exit(0);
})();
