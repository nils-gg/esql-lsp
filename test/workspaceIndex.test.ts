/**
 * Workspace index (ISSUES.md I-13).
 *
 * These tests run in BOTH modes — grammar present or `ESQL_LSP_NO_GRAMMAR=1`
 * — on purpose: the index reads files with the shared pattern extractors, so
 * cross-file SHARED resolution is exactly as guaranteed on a machine without
 * a C toolchain as on a full one. Nothing here may gate on grammar status.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFileFacts, WorkspaceIndex } from '../src/workspaceIndex';

const RECEIVER = [
  'BROKER SCHEMA com.test.recv;',
  'CREATE COMPUTE MODULE Receiver',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  DECLARE FailureCount SHARED INTEGER 0;',
  '  SET FailureCount = 0;',
  '  RETURN TRUE;',
  'END;',
  'CREATE PROCEDURE CopyMessageHeaders()',
  'BEGIN',
  '  DECLARE x INT 0;',
  'END;',
  'END MODULE;',
  '',
].join('\n');

test('extractFileFacts keeps SHARED names and drops file-local ones', () => {
  const facts = extractFileFacts(RECEIVER, 'file:///w/Receiver.esql');
  assert.ok(facts.sharedNames.has('FAILURECOUNT'), 'SHARED name, upper-cased');
  assert.ok(!facts.sharedNames.has('X'), 'a plain DECLARE is not workspace-visible');

  const names = facts.symbols.map((s) => `${s.kind}:${s.name}`);
  assert.ok(names.includes('module:Receiver'), JSON.stringify(names));
  assert.ok(names.includes('routine:Main'), JSON.stringify(names));
  assert.ok(names.includes('routine:CopyMessageHeaders'), JSON.stringify(names));
  assert.ok(names.includes('schema:com.test.recv'), JSON.stringify(names));

  const proc = facts.symbols.find((s) => s.name === 'CopyMessageHeaders')!;
  assert.equal(proc.container, 'Receiver', 'routines name their module as container');
  assert.match(proc.detail, /PROCEDURE/);
  assert.equal(proc.uri, 'file:///w/Receiver.esql');
  // The symbol range is the NAME, so a client jumping to it lands on it.
  assert.equal(proc.range.start.line, 8);
});

test('a commented-out SHARED declare is not workspace-visible', () => {
  const commented = extractFileFacts(
    [
      'CREATE COMPUTE MODULE M',
      'CREATE FUNCTION Main() RETURNS BOOLEAN',
      'BEGIN',
      "  -- DECLARE Ghost SHARED INTEGER 0; (it's a comment)",
      '  RETURN TRUE;',
      'END;',
      'END MODULE;',
      '',
    ].join('\n'),
    'file:///w/C.esql'
  );
  assert.ok(!commented.sharedNames.has('GHOST'), 'the scanner mask keeps comments inert');
});

test('rescan indexes a directory tree, honouring the skip lists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-idx-'));
  try {
    fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Receiver.esql'), RECEIVER);
    fs.writeFileSync(
      path.join(dir, 'flows', 'Handler.esql'),
      RECEIVER.replace('MODULE Receiver', 'MODULE Handler')
    );
    fs.writeFileSync(
      path.join(dir, 'node_modules', 'pkg', 'junk.esql'),
      'DECLARE Junk SHARED INT 0;\n'
    );
    fs.writeFileSync(path.join(dir, '.hidden', 'secret.esql'), 'DECLARE Hidden SHARED INT 0;\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'not esql');

    const idx = new WorkspaceIndex();
    idx.setRoot(dir);
    await idx.rescan();

    assert.deepEqual(idx.stats(), { files: 2, skipped: 0 }, 'only the two real files');
    const shared = idx.sharedNamesFromDisk();
    assert.ok(shared.has('FAILURECOUNT'));
    assert.ok(!shared.has('JUNK'), 'node_modules was skipped');
    assert.ok(!shared.has('HIDDEN'), 'dot-directories were skipped');

    const syms = idx.symbolsFromDisk();
    assert.equal(syms.filter((s) => s.kind === 'module').length, 2);
    // URIs are real file: URLs — workspace/symbol locations must open in an editor.
    assert.ok(syms.every((s) => /^file:\/\//.test(s.uri)), JSON.stringify(syms[0]?.uri));

    // Excluding a live-open file's URI removes exactly its contribution.
    const receiverUri = syms.find((s) => s.kind === 'module' && s.name === 'Receiver')!.uri;
    assert.ok(receiverUri.endsWith('/Receiver.esql'));
    const withoutReceiver = idx.sharedNamesFromDisk([receiverUri]);
    assert.ok(
      withoutReceiver.has('FAILURECOUNT'),
      'Handler.esql still declares it — the exclusion is per-file'
    );
    assert.equal(
      idx.symbolsFromDisk([receiverUri]).filter((s) => s.name === 'Receiver').length,
      0,
      'the open file is replaced by its live text, not duplicated'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversized file is skipped and counted, never parsed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-big-'));
  try {
    const big = 'DECLARE Big SHARED INT 0;\n' + '-- pad '.repeat(60 * 1024); // > 256 KB
    fs.writeFileSync(path.join(dir, 'big.esql'), big);
    fs.writeFileSync(path.join(dir, 'ok.esql'), 'DECLARE Fine SHARED INT 0;\n');
    const idx = new WorkspaceIndex();
    idx.setRoot(dir);
    await idx.rescan();
    assert.deepEqual(idx.stats(), { files: 1, skipped: 1 });
    assert.ok(idx.sharedNamesFromDisk().has('FINE'));
    assert.ok(!idx.sharedNamesFromDisk().has('BIG'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing root, or no root at all, degrades to an inert index', async () => {
  const idx = new WorkspaceIndex();
  await idx.rescan(); // no root set: nothing to scan, nothing to wait for
  assert.equal(idx.rootPath(), undefined);
  assert.equal(idx.sharedNamesFromDisk().size, 0);

  idx.setRoot(path.join(os.tmpdir(), `no-such-dir-${process.pid}-${Date.now()}`));
  await idx.rescan(); // an unreadable root must not reject
  assert.deepEqual(idx.stats(), { files: 0, skipped: 0 });
});

test('a rescan while a scan runs joins it instead of starting a second walk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-twice-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.esql'), 'DECLARE A1 SHARED INT 0;\n');
    const idx = new WorkspaceIndex();
    idx.setRoot(dir);
    const first = idx.rescan();
    const second = idx.rescan(); // joins the in-flight scan
    await Promise.all([first, second]);
    assert.ok(idx.sharedNamesFromDisk().has('A1'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── N-2: located facts + name-keyed lookup ──────────────────────────────────

test('SHARED facts carry a location, not just a name (N-2)', () => {
  const facts = extractFileFacts(RECEIVER, 'file:///w/Receiver.esql');
  const fc = facts.sharedVars.find((v) => v.name === 'FailureCount')!;
  assert.equal(fc.uri, 'file:///w/Receiver.esql');
  assert.equal(fc.range.start.line, 4, 'the DECLARE line');
  assert.equal(fc.range.start.character, 10, 'the NAME column, jump-ready');
  assert.equal(fc.range.end.character, 22, 'range spans just the name');
  assert.equal(fc.detail, 'INTEGER', 'detail is the declared type');
  assert.deepEqual([...facts.sharedNames], ['FAILURECOUNT'], 'the name set is derived');
});

test('a quoted SHARED declare is located like any other', () => {
  const facts = extractFileFacts(
    ['CREATE COMPUTE MODULE Q', 'BEGIN', "  DECLARE \"shared-encoded-host\" SHARED CHARACTER 'h';", 'END MODULE;', ''].join('\n'),
    'file:///w/Q.esql'
  );
  assert.ok(facts.sharedNames.has('SHARED-ENCODED-HOST'), 'name set knows it');
  const q = facts.sharedVars.find((v) => v.name === 'shared-encoded-host')!;
  assert.equal(q.range.start.line, 2, 'located on its line, quotes excluded');
  assert.equal(q.range.start.character, 11, 'the range starts INSIDE the quotes');
});

test('name-keyed disk lookups: case-insensitive, per-file excludable (N-2)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-lookup-'));
  try {
    fs.writeFileSync(path.join(dir, 'Receiver.esql'), RECEIVER);
    fs.writeFileSync(
      path.join(dir, 'Handler.esql'),
      RECEIVER.replace('MODULE Receiver', 'MODULE Handler')
    );
    const idx = new WorkspaceIndex();
    idx.setRoot(dir);
    await idx.rescan();

    const mains = idx.routinesNamed('main'); // lowercase query: ESQL is insensitive
    assert.equal(mains.length, 2, 'one per file, duplicates kept for the caller to rank');
    assert.ok(mains.every((s) => /FUNCTION RETURNS BOOLEAN/.test(s.detail)), 'detail for hover');
    assert.ok(mains.every((s) => s.container === 'Receiver' || s.container === 'Handler'));

    const receiverUri = mains.find((s) => s.container === 'Receiver')!.uri;
    const liveHandler = idx.routinesNamed('Main', [receiverUri]);
    assert.equal(liveHandler.length, 1, 'excluding the open file leaves exactly the sibling');
    assert.ok(!liveHandler.some((s) => s.uri === receiverUri), 'no stale disk copy of the live file');

    assert.equal(idx.sharedVarsNamed('failurecount').length, 2, 'SHARED lookup is insensitive too');
    assert.deepEqual(idx.sharedVarsNamed('no-such-var'), [], 'unknown name is just empty');
    assert.equal(
      idx.sharedVarsFromDisk([receiverUri]).length,
      1,
      'located SHARED facts exclude a live file per-file, like the name set'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
