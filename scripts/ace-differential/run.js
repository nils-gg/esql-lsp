#!/usr/bin/env node
/*
 * ACE compiler differential (enhancement: systematic grammar check vs the real
 * compiler — scripts/ace-differential).
 *
 * Compiles every probe fixture under probes/ with the IBM ACE Toolkit's
 * headless ESQL builder (mqsicreatebar -compileOnly) and parses the same
 * fixtures with our tree-sitter grammar, then compares both verdicts against
 * the expectations in manifest.json. The expectations encode the adjudication
 * in tree-sitter-esql/ACE-COMPILER-DIFFERENTIAL.md: agreement rows prove the
 * grammar models what the compiler accepts; disagreement rows are recorded
 * deliberate permissiveness (or ACE-13-only removals), so a drift in EITHER
 * direction — grammar loosened, or a future ACE/Toolkit build changing its
 * mind — fails this check.
 *
 * Requirements (all optional — the check SKIPS with exit 0 when absent, the
 * same way the grammar-dependent tests do):
 *   - an ACE install (Toolkit + Eclipse headless); default /opt/ibm/ace-13.0.9.0,
 *     override with --ace-dir <path> or $ACE_HOME
 *   - a DISPLAY the Eclipse workbench can open (e.g. Xvfb); mqsicreatebar
 *     produces nothing without one (BIP0965E)
 *
 * Usage: node scripts/ace-differential/run.js [--ace-dir PATH] [--keep-ws]
 *                                                 [--ts-only] [--list]
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const argv = process.argv.slice(2);
const argVal = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const aceDir = argVal('--ace-dir') || process.env.ACE_HOME || '/opt/ibm/ace-13.0.9.0';
const keepWs = argv.includes('--keep-ws');
const tsOnly = argv.includes('--ts-only');
const listOnly = argv.includes('--list');

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
const probeDir = path.join(HERE, 'probes');

/* ------------------------------------------------------------------ ts side */

function tsVerdicts() {
  // Mirror src/parser.ts's loading: the grammar package is ESM with a
  // top-level-await binding, so require() cannot load it — keep the
  // new Function('s','return import(s)') trick.
  const trueDynamicImport = new Function('s', 'return import(s)');
  const mod = require('tree-sitter');
  const ParserClass = mod.default ?? mod;
  return trueDynamicImport('tree-sitter-esql').then((esql) => {
    const grammar = esql.default ?? esql;
    const parser = new ParserClass();
    parser.setLanguage(grammar);
    const hasError = (node) => {
      if (node.type === 'ERROR' || node.isMissing) return true;
      for (let i = 0; i < node.childCount; i++) if (hasError(node.child(i))) return true;
      return false;
    };
    const verdicts = {};
    for (const p of manifest.probes) {
      const src = fs.readFileSync(path.join(probeDir, p.file), 'utf8');
      verdicts[p.file] = hasError(parser.parse(src).rootNode) ? 'reject' : 'accept';
    }
    return verdicts;
  });
}

/* ----------------------------------------------------------------- ace side */

// The Toolkit project template that turns a folder into an ESQL-checking
// message-set project: nature com.ibm.etools.msg.validation.msetnature +
// builder com.ibm.etools.mft.esql.lang.esqllangbuilder. The builder does
// syntax + routine-signature checks; it does NOT resolve variables, so probe
// files may reference undeclared names (that is what makes them probes and
// not test programs).
const PROJECT_XML = (name) => `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
\t<name>${name}</name>
\t<comment></comment>
\t<projects></projects>
\t<buildSpec>
\t\t<buildCommand>
\t\t\t<name>com.ibm.etools.mft.esql.lang.esqllangbuilder</name>
\t\t\t<arguments></arguments>
\t\t</buildCommand>
\t</buildSpec>
\t<natures>
\t\t<nature>com.ibm.etools.msg.validation.msetnature</nature>
\t</natures>
</projectDescription>
`;

function aceVerdicts(ws) {
  const PROJ = 'PROBES';
  const projDir = path.join(ws, PROJ);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, '.project'), PROJECT_XML(PROJ));
  for (const f of fs.readdirSync(probeDir)) {
    if (f.endsWith('.esql')) fs.copyFileSync(path.join(probeDir, f), path.join(projDir, f));
  }
  const traceLog = path.join(ws, 'mcb-trace.log');
  const profile = [
    path.join(aceDir, 'server', 'bin', 'mqsiprofile'),
    path.join(aceDir, 'server', 'mqsiprofile'),
  ].find((p) => fs.existsSync(p));
  const cmd =
    (profile ? `. '${profile}' >/dev/null 2>&1; ` : '') +
    `'${aceDir}/tools/mqsicreatebar' -data '${ws}' -p ${PROJ} -compileOnly -trace -v '${traceLog}'`;
  const run = spawnSync('bash', ['-c', cmd], { env: process.env, timeout: 600000 });
  if (run.error) throw new Error(`cannot run mqsicreatebar: ${run.error.message}`);

  // Per-file verdicts: an error marker `Problem N: Resource - /PROBES/x.esql;
  // Error message - …` rejects that file; a file with no marker compiled.
  // IMPORTANT: the workspace must be fresh (we mkdtemp above) — Eclipse
  // problem markers from an earlier run of an old workspace persist and
  // pollute the verdicts.
  if (!fs.existsSync(traceLog)) {
    if (!process.env.DISPLAY) {
      throw new Error(
        'mqsicreatebar produced no trace log and DISPLAY is unset — ' +
        'the Eclipse workbench needs a display (e.g. Xvfb) to compile',
      );
    }
    throw new Error(
      `mqsicreatebar produced no trace log (rc=${run.status}); tail:\n` +
      String(run.stdout).split('\n').slice(-8).join('\n'),
    );
  }
  const text = fs.readFileSync(traceLog, 'utf8');
  const rejected = new Set();
  const messages = {};
  const re = new RegExp(`Problem \\d+: Resource - \\/${PROJ}\\/([^;]+); Error message - (.*)$`, 'gm');
  let m;
  while ((m = re.exec(text))) {
    rejected.add(m[1]);
    if (!messages[m[1]]) messages[m[1]] = m[2].trim();
  }
  // Sanity: if the command died before compiling anything, markers will be
  // absent AND rc nonzero with a BIP failure line — distinguish that from
  // "all probes compiled".
  if (run.status !== 0 && rejected.size === 0 && !/BIP0986I/.test(text)) {
    throw new Error(
      `mqsicreatebar failed without per-file markers (rc=${run.status}); ` +
      'likely a workspace/CLI problem, not a probe verdict. Log tail:\n' +
      text.split('\n').slice(-10).join('\n'),
    );
  }
  const verdicts = {};
  for (const p of manifest.probes) {
    verdicts[p.file] = rejected.has(p.file) ? 'reject' : 'accept';
  }
  return { verdicts, messages };
}

/* --------------------------------------------------------------------- main */

(async () => {
  const names = manifest.probes.map((p) => p.file);
  if (listOnly) {
    names.forEach((n) => console.log(n));
    return;
  }

  const ts = await tsVerdicts();

  let ace = null;
  let aceMessages = {};
  let skipped = null;
  if (tsOnly) {
    skipped = '--ts-only was given';
  } else if (!fs.existsSync(path.join(aceDir, 'tools', 'mqsicreatebar'))) {
    skipped = `no ACE Toolkit at ${aceDir} (set --ace-dir or $ACE_HOME)`;
  } else if (!process.env.DISPLAY) {
    skipped = `DISPLAY is unset — mqsicreatebar cannot open the workbench (use e.g. an Xvfb)`;
  } else {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-ace-diff-'));
    try {
      const r = aceVerdicts(ws);
      ace = r.verdicts;
      aceMessages = r.messages;
      if (keepWs) console.log(`workspace kept at ${ws}`);
    } finally {
      if (!keepWs && fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true });
    }
  }
  if (skipped) {
    console.log(`SKIP ace-differential: ${skipped}`);
    console.log('checking the tree-sitter side against the manifest anyway:');
  }

  let bad = 0;
  const width = Math.max(...names.map((n) => n.length));
  for (const p of manifest.probes) {
    const tsOk = ts[p.file] === p.ts;
    const aceOk = !ace || ace[p.file] === p.ace;
    if (tsOk && aceOk) continue;
    bad++;
    const bits = [];
    if (!tsOk) bits.push(`ts: expected ${p.ts}, got ${ts[p.file]}`);
    if (ace && !aceOk) bits.push(`ace: expected ${p.ace}, got ${ace[p.file]} (${aceMessages[p.file] || 'no message'})`);
    console.log(`MISMATCH ${p.file.padEnd(width)}  ${bits.join('; ')}   [class ${p.class}]`);
  }

  // Verbose per-probe table only for the full run (the informative case).
  if (ace) {
    console.log('');
    console.log('probe'.padEnd(width) + '  ace     ts      expected          class');
    for (const p of manifest.probes) {
      const mark = ace[p.file] === p.ace && ts[p.file] === p.ts ? 'ok' : 'MISMATCH';
      console.log(
        p.file.padEnd(width) + '  ' +
        `${ace[p.file]}  ${ts[p.file]}      ${(p.ace + '/' + p.ts).padEnd(15)} ${p.class}  ${mark}`,
      );
    }
  }

  const total = manifest.probes.length;
  const accepted = Object.values(ts).filter((v) => v === 'accept').length;
  console.log(`\nts grammar: ${accepted}/${total} probes parse without ERROR/MISSING`);
  if (ace) {
    const aceAcc = Object.values(ace).filter((v) => v === 'accept').length;
    console.log(`ace compiler: ${aceAcc}/${total} probes compile`);
  }
  if (bad) {
    console.log(`DRIFT: ${bad}/${total} probes disagree with manifest.json — re-adjudicate against`);
    console.log('the ACE 12.0.x diagrams (tree-sitter-esql/VERIFICATION.md) before changing either side.');
    process.exit(1);
  }
  console.log(ace ? 'All probes match the manifest.' : 'All tree-sitter verdicts match the manifest (ace side skipped).');
})().catch((e) => {
  console.error('ace-differential run failed:', e.message);
  process.exit(2);
});
