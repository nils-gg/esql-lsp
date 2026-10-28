/**
 * Path and URI handling across platforms (list.md 9, enhancement 27).
 *
 * Windows differs from the Linux CI this project grew up on in three ways the
 * codebase touches directly: paths compare case-insensitively, npm hands the
 * server drive-letter URIs (`file:///C%3A/...`), and UNC shares arrive as
 * `file://host/...` that a POSIX box cannot interpret at all. The win32 branches
 * run here too, by stubbing `process.platform` — so a Linux checkout pins the
 * Windows semantics instead of leaving them to the platform CI job alone.
 *
 * These tests run in BOTH modes — grammar present or `ESQL_LSP_NO_GRAMMAR=1` —
 * on purpose: the workspace index reads files with the shared pattern
 * extractors, so nothing here may gate on grammar status (AGENTS.md).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WorkspaceIndex } from '../src/workspaceIndex';

const CREATED = 1;
const CHANGED = 2;

/**
 * Run `fn` with `process.platform` reporting `platform`. Node's test runner
 * gives each FILE its own process, so the stub cannot leak into another suite —
 * but restore it anyway: the same file also asserts the POSIX direction.
 */
function withPlatform<T>(platform: string, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

const SENDER = [
  'BROKER SCHEMA com.test.send;',
  'CREATE COMPUTE MODULE Sender',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  DECLARE TicketCount SHARED INTEGER 0;',
  '  SET TicketCount = 0;',
  '  RETURN TRUE;',
  'END;',
  'CREATE PROCEDURE FlushBatch()',
  'BEGIN',
  '  DECLARE y INT 0;',
  'END;',
  'END MODULE;',
  '',
].join('\n');

test('root removal case-folds only where the filesystem does (win32 vs POSIX)', () => {
  const idx = new WorkspaceIndex();
  idx.addRoot('/w/Project');
  // POSIX paths are case-sensitive: a differently cased spelling is a different
  // folder, and silently removing the wrong root would drop live symbols.
  assert.equal(idx.removeRoot('/w/pROJECT'), false, 'case-sensitive comparison on POSIX');
  assert.equal(idx.hasRoot(), true, 'the mismatched spelling removed nothing');

  withPlatform('win32', () => {
    // Windows: NTFS is case-insensitive, and clients really do send drive-letter
    // and case drift between initialize and didChangeWorkspaceFolders.
    assert.equal(idx.removeRoot('/w/pROJECT'), true, 'case-folded comparison on win32');
    assert.equal(idx.hasRoot(), false, 'the root the client meant is the root that left');
  });
});

test('file names needing URI escaping index, look up, and update as ONE file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-uri-'));
  try {
    // '#', '%', space, accented and CJK characters: every one of these has a
    // percent-encoding story between fs path and client URI, and '#' truncates
    // any URI built by string concatenation.
    const file = path.join(dir, 'we#ird % é 模块.esql');
    fs.writeFileSync(file, SENDER, 'utf8');

    const idx = new WorkspaceIndex();
    idx.setRoots([dir]);
    await idx.rescan();
    assert.deepEqual(idx.stats(), { files: 1, skipped: 0 }, JSON.stringify(idx.stats()));

    const vars = idx.sharedVarsNamed('ticketcount');
    assert.equal(vars.length, 1, 'the SHARED var is found through the escaped name');
    assert.equal(vars[0].name, 'TicketCount', 'declared spelling survives');
    assert.equal(vars[0].uri, pathToFileURL(file).href, 'facts carry the client-shaped URI');
    assert.equal(fileURLToPath(vars[0].uri), file, 'and it decodes back to the exact file');
    assert.equal(idx.routinesNamed('FlushBatch').length, 1, 'routines survive the same path');

    // A watch event for the escaped URI must land on the SAME entry: a naive
    // second key here double-indexes the file and duplicates every symbol.
    assert.equal(await idx.applyWatchEvent(vars[0].uri, CHANGED), true, 'event applied');
    assert.deepEqual(idx.stats(), { files: 1, skipped: 0 }, 'the event re-entered, not appended');
    assert.equal(idx.sharedVarsNamed('TICKETCOUNT').length, 1, 'no symbol duplication');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('URIs this OS cannot honour are declined, never a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-uri-fg-'));
  try {
    fs.writeFileSync(path.join(dir, 'plain.esql'), SENDER, 'utf8');
    const idx = new WorkspaceIndex();
    idx.setRoots([dir]);
    await idx.rescan();

    const foreign: Array<[string, string]> = [
      // A client on Windows sends drive-letter URIs; on POSIX fileURLToPath
      // turns them into a harmless '/C:/...' string that lives under no root.
      ['file:///C%3A/Project/Late.esql', 'Windows drive letter'],
      // UNC shares are real paths on Windows but throw on POSIX.
      ['file://HOST/share/Late.esql', 'UNC host'],
      // A percent-escape this side cannot decode.
      ['file:///w/a%esql.esql', 'malformed percent escape'],
      // Non-file schemes never belong to the index.
      ['untitled:Untitled-1', 'untitled scheme'],
    ];
    for (const [uri, why] of foreign) {
      assert.equal(await idx.applyWatchEvent(uri, CREATED), false, `declined: ${why}`);
    }
    assert.deepEqual(idx.stats(), { files: 1, skipped: 0 }, 'nothing foreign leaked into the index');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
