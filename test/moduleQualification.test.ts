/**
 * Module-qualified routine resolution (issue 3 / issue 5, Enh 34/36) and the
 * rename anchored on it (Enh 17/33) — file-local half, run in BOTH analysis
 * modes: the qualification filter is scanner/CALL-region driven by design,
 * so grammar and heuristic answers must be identical, not merely similar.
 *
 * One file, three modules: Alpha and Beta each declare a `Helper`; Caller
 * calls both qualified and the bare name once. Worker's unqualified
 * `CALL Helper(name)` sits inside Alpha and means Alpha's.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Range } from 'vscode-languageserver';
import { parse, analyzeDocument, DocAnalysis, grammarReady, initGrammar } from '../src/parser';
import {
  definitionAt,
  referencesAt,
  callTargetAt,
  callSitesForName,
  qualifierMatchesModule,
  unqualifiedUnguardedSites,
} from '../src/definitions';

const SRC = [
  'CREATE COMPUTE MODULE Alpha', //                    0  Alpha 22-27
  '',
  '    CREATE PROCEDURE Helper(IN name CHARACTER)', // 2  Helper 21-27
  '    BEGIN',
  "        SET name = 'a';",
  '    END;',
  '',
  '    CREATE PROCEDURE Worker()',
  '    BEGIN',
  '        CALL Helper(name);', //                     9  Helper 13-19, inside Alpha
  '    END;',
  '',
  'END MODULE;',
  '',
  'CREATE COMPUTE MODULE Beta', //                     14 Beta 22-26
  '',
  '    CREATE PROCEDURE Helper(IN name CHARACTER)', // 16 Helper 21-27
  '    BEGIN',
  "        SET name = 'b';",
  '    END;',
  '',
  'END MODULE;',
  '',
  'CREATE COMPUTE MODULE Caller', //                   23
  '',
  '    CREATE FUNCTION Main() RETURNS BOOLEAN',
  '    BEGIN',
  "        CALL Alpha.Helper('one');", //              27 Helper 19-25
  "        CALL Beta.Helper('two');", //               28 Helper 18-24
  "        CALL Helper('three');", //                  29 Helper 13-19 (ambiguous)
  '        RETURN TRUE;',
  '    END;',
  '',
  'END MODULE;', //                                    33
].join('\n');

function format(ranges: Range[]): string[] {
  return ranges.map((r) => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`);
}

let cachedTree: DocAnalysis | undefined;
let treeChecked = false;

async function tree(): Promise<DocAnalysis | undefined> {
  if (!treeChecked) {
    treeChecked = true;
    await initGrammar();
    cachedTree = grammarReady() ? analyzeDocument(parse(SRC)!) : undefined;
  }
  return cachedTree;
}

async function bothModes(
  label: string,
  run: (doc: DocAnalysis | undefined) => Range[],
  expected: string[]
): Promise<void> {
  assert.deepEqual(format(run(undefined)), expected, `${label} (heuristic)`);
  const doc = await tree();
  if (doc) assert.deepEqual(format(run(doc)), expected, `${label} (grammar)`);
}

test('definition: a qualified CALL resolves through its module, not the name alone', async () => {
  await bothModes('Alpha.Helper', (doc) => definitionAt(SRC, 27, 20, doc), ['2:21-2:27']);
  await bothModes('Beta.Helper', (doc) => definitionAt(SRC, 28, 20, doc), ['16:21-16:27']);
});

test('definition: an unqualified call inside a module means THAT module’s routine', async () => {
  // Worker's CALL sits in Alpha: Beta's same-named Helper is a different symbol.
  await bothModes('bare in Worker', (doc) => definitionAt(SRC, 9, 14, doc), ['2:21-2:27']);
});

test('definition: a genuinely ambiguous bare call lists every candidate (Enh 36)', async () => {
  // The CALLer module declares no Helper of its own — nothing can be chosen.
  await bothModes('bare in Caller', (doc) => definitionAt(SRC, 29, 14, doc), [
    '2:21-2:27',
    '16:21-16:27',
  ]);
});

test('definition: the qualifier word itself jumps to the MODULE declaration', async () => {
  await bothModes('on Alpha', (doc) => definitionAt(SRC, 27, 15, doc), ['0:22-0:27']);
});

test('references: from Alpha’s Helper — its sites only, never Beta’s', async () => {
  await bothModes('from Alpha decl', (doc) => referencesAt(SRC, 2, 24, true, doc), [
    '2:21-2:27', // the declaration itself
    '9:13-9:19', // same-module unqualified call
    '27:19-27:25', // Alpha.Helper — a reference to THIS one
    '29:13-29:19', // the ambiguous bare use (could mean either: honest listing)
  ]);
  await bothModes('uses only', (doc) => referencesAt(SRC, 2, 24, false, doc), [
    '9:13-9:19',
    '27:19-27:25',
    '29:13-29:19',
  ]);
});

test('references: from Beta’s Helper — the mirror image', async () => {
  await bothModes('from Beta decl', (doc) => referencesAt(SRC, 16, 24, true, doc), [
    '16:21-16:27',
    '28:18-28:24',
    '29:13-29:19',
  ]);
});

test('references: a rival module’s qualified spelling never joins the list', async () => {
  // The old grammar path answered every same-named routine in the file;
  // these two assertions are the regression pin for that split.
  const refsAlpha = format(referencesAt(SRC, 2, 24, true, undefined));
  assert.ok(!refsAlpha.includes('16:21-16:27'), 'Beta declaration is not an Alpha reference');
  assert.ok(!refsAlpha.includes('28:18-28:24'), 'Beta.Helper is not an Alpha reference');
});

test('callTargetAt: CALL regions, qualifiers and the non-CALL dotted form', () => {
  assert.deepEqual(callTargetAt(SRC, 27, 20), { name: 'Helper', qualifier: ['Alpha'], cursorOnName: true });
  assert.deepEqual(callTargetAt(SRC, 27, 15), { name: 'Helper', qualifier: ['Alpha'], cursorOnName: false });
  assert.deepEqual(callTargetAt(SRC, 29, 14), { name: 'Helper', qualifier: [], cursorOnName: true });
  // A message-tree path is NOT a call target, and a quoted name masks away.
  assert.equal(callTargetAt('        SET OutputRoot.JSON.Data = 1;', 0, 20), null);
  assert.equal(callTargetAt('    CALL "Weird Name"(x);', 0, 10), null);
});

test('callSitesForName: every CALL site with its qualifier (mode-agnostic)', () => {
  assert.deepEqual(
    callSitesForName(SRC, 'Helper').map((s) => [
      s.qualifier.join('.'),
      `${s.range.start.line}:${s.range.start.character}`,
    ]),
    [
      ['', '9:13'],
      ['Alpha', '27:19'],
      ['Beta', '28:18'],
      ['', '29:13'],
    ]
  );
});

test('qualifierMatchesModule: any segment may carry the module, case-insensitively', () => {
  assert.ok(qualifierMatchesModule(['Alpha'], 'alpha'));
  assert.ok(qualifierMatchesModule(['Com.Broker', 'Alpha'], 'ALPHA'));
  assert.ok(!qualifierMatchesModule(['Beta'], 'Alpha'));
  assert.ok(!qualifierMatchesModule([], 'Alpha'));
});

test('unqualifiedUnguardedSites: only the genuinely ambiguous bare use counts', () => {
  // 9:13 sits inside Alpha (owned), the qualified spellings name a module,
  // and declaration slots are not uses — 29:13 is the one rename hazard.
  assert.deepEqual(format(unqualifiedUnguardedSites(SRC, 'Helper')), ['29:13-29:19']);
});
