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
 * I-16 measured the way a client is served: a REAL stdio session, one long-lived
 * server with every corpus document open, and the `textDocument/completion`
 * request the editor would send. The answer is then checked against the scope
 * ranges the server itself computed (same `rangeContains` the server uses), so
 * "out of scope" means "the server's own scope data says this name is not
 * visible here" — no assumption about how the filtering is implemented.
 *
 * The positions are the same set t-scope-comp.js probes: use sites of shadowed
 * names plus one SET target per routine.
 */
const { spawn } = require('child_process');
const { initGrammar, parse, analyzeDocument } = DIST('src/parser');
const { rangeContains, declarationsFromSource } = DIST('src/definitions');
const MODE = process.argv.includes('--heuristic') ? 'heuristic' : 'grammar';
const root = corpusDir(process.argv.slice(2));

class C {
  constructor(env) {
    this.child = spawn('node', [SERVER], { stdio: 'pipe', env: { ...process.env, ...(env || {}) } });
    this.buf = Buffer.alloc(0);
    this.id = 1;
    this.p = new Map();
    this.child.stdout.on('data', (d) => this.feed(d));
    this.child.stderr.on('data', () => {});
  }
  send(m) {
    const b = JSON.stringify(m);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`);
  }
  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  req(method, params) {
    const id = this.id++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((res) => this.p.set(id, res));
  }
  feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n');
      if (h === -1) return;
      const len = parseInt(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, h).toString())[1], 10);
      if (this.buf.length < h + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(h + 4, h + 4 + len).toString());
      this.buf = this.buf.subarray(h + 4 + len);
      if (msg.id && this.p.has(msg.id)) {
        const cb = this.p.get(msg.id);
        this.p.delete(msg.id);
        cb(msg);
      }
    }
  }
  kill() {
    this.child.kill();
  }
}

const files = [];
(function w(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) w(p);
    else if (p.endsWith('.esql')) files.push(p);
  }
})(root);

(async () => {
  await initGrammar();
  const c = new C(MODE === 'heuristic' ? { ESQL_LSP_NO_GRAMMAR: '1' } : undefined);
  const init = await c.req('initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } },
    initializationOptions: {},
  });
  if (!init.result?.capabilities?.completionProvider) throw new Error('no completion provider');
  c.notify('initialized', {});

  // Everything the probe needs to know about each file, computed locally with the
  // same code the server runs.
  const plan = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const tree = MODE === 'heuristic' ? null : parse(text);
    if (MODE !== 'heuristic' && !tree) continue;
    const doc =
      MODE === 'heuristic'
        ? { declaredNames: declarationsFromSource(text), routines: [] }
        : analyzeDocument(tree);
    const lines = text.split(/\r?\n|\r/);
    const uri = 'file://' + f;
    c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'esql', version: 1, text } });
    const pts = [];
    const byName = new Map();
    for (const d of doc.declaredNames) {
      const k = d.name.toUpperCase();
      (byName.get(k) || byName.set(k, []).get(k)).push(d);
    }
    for (const [name, decls] of byName) {
      if (decls.length < 2) continue;
      const re = new RegExp(`(?<![A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`, 'gi');
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(DECLARE|--)/i.test(lines[i])) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lines[i]))) pts.push({ line: i, ch: m.index + name.length });
      }
    }
    const rs = [...doc.routines].sort((a, b) => a.range.start.line - b.range.start.line);
    if (!rs.length) {
      for (let i = 0; i < lines.length; i++) {
        const m = /\bSET\s+([A-Za-z_][\w.]*)\s*=/i.exec(lines[i]);
        if (m) pts.push({ line: i, ch: m.index + m[0].length - 1 });
      }
    }
    for (let ri = 0; ri < rs.length; ri++) {
      const start = rs[ri].range.start.line;
      const end = ri + 1 < rs.length ? rs[ri + 1].range.start.line - 1 : lines.length - 1;
      for (let i = start; i <= end && i < lines.length; i++) {
        const m = /\bSET\s+([A-Za-z_][\w.]*)\s*=/i.exec(lines[i]);
        if (m) {
          pts.push({ line: i, ch: m.index + m[0].length - 1 });
          break;
        }
      }
    }
    plan.push({ f, uri, lines, declarations: doc.declaredNames, pts });
  }

  let probes = 0, filesSeen = 0, filesOut = 0, positionsOut = 0, namesOut = 0, worst = 0, worstAt = '';
  let totalItems = 0, emptyAnswers = 0, errors = 0;
  for (const p of plan) {
    let fileProbes = 0, fileOut = 0;
    for (const pt of p.pts) {
      const l = p.lines[pt.line] || '';
      const ch = Math.max(0, Math.min(pt.ch, l.length));
      if (!l.slice(0, ch).trim()) continue;
      const r = await c.req('textDocument/completion', {
        textDocument: { uri: p.uri },
        position: { line: pt.line, character: ch },
      });
      probes++;
      fileProbes++;
      const items = r.result ?? r;
      if (r.error) {
        errors++;
        continue;
      }
      const list = Array.isArray(items) ? items : items?.items ?? [];
      totalItems += list.length;
      if (!list.length) emptyAnswers++;
      const labels = new Set(list.map((i) => String(i.label).toUpperCase()));
      // A label is offered illegitimately only when NO declaration of that name
      // is visible here. `USERNAME` declared in this routine and `username` a
      // parameter of some other routine are different declarations of the same
      // spelling: the first one's being offered is correct even though the
      // second is far out of scope, so test per NAME, not per declaration.
      const visible = new Set(
        p.declarations.filter((d) => rangeContains(d.scope, pt.line, ch)).map((d) => d.name.toUpperCase())
      );
      // The server marks its own declarations on the wire: every item that came
      // from a DECLARE carries detail "Declared: …" (and dedupe makes that form
      // win a label collision with a built-in). So ask exactly the question that
      // matters — is every item the server claims is a declared name actually
      // visible here? — instead of guessing from label spellings.
      const declared = list.filter((i) => String(i.detail ?? '').startsWith('Declared:'));
      const out = declared.filter((i) => !visible.has(String(i.label).toUpperCase()));
      if (out.length) {
        positionsOut++;
        fileOut++;
        namesOut += new Set(out.map((i) => String(i.label).toUpperCase())).size;
        if (out.length > worst) {
          worst = out.length;
          worstAt = `${path.relative(root, p.f)} line ${pt.line + 1}:${ch} offers ${out.length}: ${out
            .map((i) => `${i.label} (kind ${i.kind}, ${JSON.stringify(i.detail)})`)
            .join('; ')}`;
        }
      }
    }
    if (fileProbes) {
      filesSeen++;
      if (fileOut) filesOut++;
    }
  }

  console.log(`mode                        : ${MODE} (real stdio session, ${plan.length} documents open)`);
  console.log(`probed completion positions : ${probes} in ${filesSeen} files`);
  console.log(`items served                : ${totalItems} (empty answers: ${emptyAnswers}, rpc errors: ${errors})`);
  console.log(
    `positions offering >=1 name whose own scope excludes them: ${positionsOut}  (files: ${filesOut})` +
      ` · distinct names summed over files: ${namesOut}`
  );
  console.log(`worst: ${worst}\n  ${worstAt}`);
  c.kill();
})();
