/**
 * Unicode position regressions (list.md issue 1 / enhancement 19).
 *
 * tree-sitter node bindings report UTF-8 BYTE offsets and byte columns; LSP
 * positions and every JS-string regex here count UTF-16 code units. Mixed
 * naively, one accented letter, one CJK character, or one emoji before a
 * declaration silently shifts every tree-derived range off the right text.
 *
 * These fixtures put non-ASCII (accented Latin, CJK, astral emoji, a quoted
 * name with accents) EARLY in the document and then assert that every
 * tree-derived range still lands exactly on its name — measured by slicing
 * the document at the range and demanding the name back. That is the mode-
 * independent truth: the heuristic path has always been character-based, so
 * anything the tree path answers differently is the bug.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { initGrammar, parse, analyzeDocument, semanticTokensForTree, clausePrefixAt, grammarReady } from '../src/parser';
import { documentSymbols, documentSymbolsFromTree } from '../src/symbols';
import { definitionAt, referencesAt } from '../src/definitions';
import { analyze } from '../src/diagnostics';
import { DEFAULT_SETTINGS } from '../src/settings';
import { linesOf, scan } from '../src/scanner';
import { byteOffsetsFor } from '../src/positions';
import { skipWithoutGrammar } from './grammarStatus';

/** Accents, CJK, and an astral emoji (4 UTF-8 bytes / 2 UTF-16 units) early. */
const UNICODE_SAMPLE = [
  '-- Setup café: accents é, CJK 你好, emoji 😀 everywhere this line sits', // 0
  'BROKER SCHEMA com.example.uni;', // 1
  '', // 2
  'CREATE COMPUTE MODULE UniModule', // 3
  'DECLARE count INTEGER 0;         -- accented trailing comment é', // 4
  "DECLARE msg CHARACTER '你好';", // 5
  '', // 6
  'CREATE FUNCTION Main() RETURNS BOOLEAN', // 7
  'BEGIN', // 8
  "  SET msg = 'emoji 😀 in a string';", // 9
  "  SET msg = 'more 你好';            -- and a comment 你好", // 10
  '  DECLARE total INTEGER;', // 11
  '  SET total = count;               -- 😀 shifts bytes again', // 12
  '  RETURN TRUE;', // 13
  'END;', // 14
  'END MODULE;', // 15
  '',
].join('\n');

/** Same document the way a Windows client sends it (CRLF terminators). */
const UNICODE_CRLF = UNICODE_SAMPLE.split('\n').join('\r\n');

/** The text an LSP Range actually selects — the assertion that must never lie. */
function textAt(text: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }): string {
  const lines = linesOf(text);
  if (range.start.line !== range.end.line) return lines[range.start.line].slice(range.start.character) + '\n…';
  return (lines[range.start.line] ?? '').slice(range.start.character, range.end.character);
}

async function analyzeOf(text: string) {
  await initGrammar();
  const tree = parse(text);
  return tree ? analyzeDocument(tree, text) : null;
}

test('every tree-derived range selects exactly its own name on a Unicode document', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const analysis = await analyzeOf(UNICODE_SAMPLE);
  assert.ok(analysis, 'tree expected');

  for (const d of analysis.declaredNames) {
    assert.equal(textAt(UNICODE_SAMPLE, d.range), d.name, `DECLARE ${d.name} range`);
  }
  for (const r of analysis.routines) {
    assert.equal(textAt(UNICODE_SAMPLE, r.range), r.name, `routine ${r.name} range`);
  }
  for (const m of analysis.modules) {
    assert.equal(textAt(UNICODE_SAMPLE, m.nameRange), m.name, `module ${m.name} range`);
  }
  for (const s of analysis.schemas) {
    assert.ok(s.name.startsWith(textAt(UNICODE_SAMPLE, s.range)), `schema range prefix`);
  }
  for (const ref of analysis.references) {
    assert.equal(
      textAt(UNICODE_SAMPLE, ref.range).toUpperCase(),
      ref.name.toUpperCase(),
      `reference ${ref.name} (${ref.kind}) range at ${ref.range.start.line}:${ref.range.start.character}`
    );
  }
  assert.deepEqual(analysis.errorRegions, [], 'fixture must stay grammar-clean');
});

test('definition and references answer the right characters after non-ASCII', async (t) => {
  await initGrammar();
  if (!grammarReady()) {
    t.skip('needs the tree path to be the interesting half');
    return;
  }
  const analysis = (await analyzeOf(UNICODE_SAMPLE))!;
  // Cursor on the USE of `count` at line 12 (character column measured by hand
  // in UTF-16 units, exactly what a client sends).
  const line12 = linesOf(UNICODE_SAMPLE)[12];
  const col = line12.indexOf('count') + 2;
  const defs = definitionAt(UNICODE_SAMPLE, 12, col, analysis ?? undefined);
  assert.ok(defs.length, 'count must resolve');
  for (const r of defs) assert.equal(textAt(UNICODE_SAMPLE, r), 'count', 'definition range text');

  const refs = referencesAt(UNICODE_SAMPLE, 12, col, true, analysis ?? undefined);
  assert.ok(refs.length >= 2, `uses + declaration, got ${refs.length}`);
  for (const r of refs) assert.equal(textAt(UNICODE_SAMPLE, r), 'count', 'reference range text');
});

test('the tree path and the pattern path agree on every name position (Unicode)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const outline = (symbols: ReturnType<typeof documentSymbols>, depth = 0): string[] => {
    const out: string[] = [];
    for (const s of symbols) {
      out.push(`${'  '.repeat(depth)}${s.kind}:${s.name}@${s.selectionRange.start.line}:${s.selectionRange.start.character}`);
      if (s.children) out.push(...outline(s.children, depth + 1));
    }
    return out;
  };
  const tree = parse(UNICODE_SAMPLE);
  assert.ok(tree);
  const fromTree = outline(documentSymbolsFromTree(analyzeDocument(tree!, UNICODE_SAMPLE)));
  const fromPattern = outline(documentSymbols(UNICODE_SAMPLE));
  assert.deepEqual(fromTree, fromPattern, 'both extraction paths must land on the same characters');
});

test('semantic tokens stay inside the client line lengths on a Unicode document', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const tree = parse(UNICODE_SAMPLE);
  assert.ok(tree);
  const data = semanticTokensForTree(tree!, UNICODE_SAMPLE);
  assert.ok(data && data.length >= 5, 'tokens expected');
  const lines = linesOf(UNICODE_SAMPLE);
  let line = 0;
  let base = 0; // previous token's START on the current line (LSP delta rule)
  for (let i = 0; i < data.length; i += 5) {
    const [dl, dc, len] = data.slice(i, i + 3) as number[];
    if (dl !== 0) {
      line += dl;
      base = 0;
    }
    const char = base + dc;
    assert.ok(line < lines.length, `token line ${line} inside the document`);
    assert.ok(
      char >= 0 && char + len <= lines[line].length,
      `token at ${line}:${char}+${len} fits '${lines[line]}'`
    );
    base = char;
  }
});

test('clausePrefixAt converts the cursor offset before walking the tree', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const text = UNICODE_SAMPLE;
  const tree = parse(text);
  assert.ok(tree);
  // Cursor just past `count` on line 12 — five non-ASCII-bearing lines above.
  const line = linesOf(text)[12];
  const character = line.indexOf('count') + 'count'.length;
  const offset = linesOf(text).slice(0, 12).reduce((n, l) => n + l.length + 1, 0) + character;
  const prefix = clausePrefixAt(tree!, scan(text).masked, offset, text);
  assert.equal(prefix, 'SET total = count', 'clause text must be the cursor prefix, not a byte-skewed slice');
});

test('ranges survive CRLF + Unicode exactly as the LF case (issue 27 too)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const analysis = await analyzeOf(UNICODE_CRLF);
  assert.ok(analysis);
  for (const d of analysis.declaredNames) {
    assert.equal(textAt(UNICODE_CRLF, d.range), d.name, `DECLARE ${d.name} on CRLF`);
  }
  for (const ref of analysis.references) {
    assert.equal(textAt(UNICODE_CRLF, ref.range).toUpperCase(), ref.name.toUpperCase(), `reference ${ref.name} on CRLF`);
  }
});

test('diagnostics underline the exact name on a Unicode document (both modes)', async () => {
  await initGrammar();
  const broken = [
    "DECLARE okVar CHARACTER;       -- café é 你好 😀 shift the byte offsets", // 0
    "SET okVar = 'a string 你好 too'; -- and this line carries them too", // 1
    'SET undeclaredVar = okVar;', // 2 — undeclared, after Unicode earlier
  ].join('\n');
  const analysis = await analyzeOf(broken);
  const diags = analyze(broken, DEFAULT_SETTINGS.diagnostics, analysis ?? undefined);
  const miss = diags.find((d) => d.message.includes("'undeclaredVar'"));
  assert.ok(miss, `undeclaredVar must be reported, got ${JSON.stringify(diags.map((d) => d.message))}`);
  assert.equal(
    textAt(broken, miss.range),
    'undeclaredVar',
    `diagnostic range must cover exactly the name (got '${textAt(broken, miss.range)}')`
  );
});

// ─── the converter itself (positions.ts) ─────────────────────────────────────

test('utf8 byte-index mode maps every codepoint boundary of a torture string both ways', () => {
  const torture = 'aé你😀\r\nb\u00e9\t🙂 中\nend';
  const p = byteOffsetsFor(torture, 'utf8', 'utf8');
  assert.equal(p.identity, false);
  let bytes = 0;
  for (let i = 0; i < torture.length; ) {
    assert.equal(p.byte(i), bytes, `byte(${i})`);
    // Round-trip: the byte offset of a boundary converts back to that boundary.
    assert.equal(p.index(bytes), i, `index(${bytes})`);
    const c = torture.codePointAt(i)!;
    const step = c <= 0x7f ? 1 : c <= 0x7ff ? 2 : c <= 0xffff ? 3 : 4;
    bytes += step;
    i += c > 0xffff ? 2 : 1;
  }
  assert.equal(p.byte(torture.length), bytes, 'end sentinel');
});

test('byte point-columns convert to UTF-16 characters mid-line and across a lone-\\r row', () => {
  // The measured node regime: byte columns, utf16 indexes. é=2 你=3 好=3 bytes.
  const text = "SET a = 'é\u4f60\u597d';\rSET bb = 1;";
  const p = byteOffsetsFor(text, 'utf8', 'utf16');
  assert.equal(p.identity, false);
  // bb sits at byte column 4 ("SET " — ASCII) of row 1: identity there.
  assert.deepEqual(p.point(1, 4), { line: 1, character: 4 });
  // The '好' on row 0: byte column 13 (SET a = 'é你好) is character 11.
  assert.deepEqual(p.point(0, 13), { line: 0, character: 11 });
  assert.equal(p.index(13), 13, 'utf16 indexes pass through');
});

test('utf8-mode ByteOffsets still collapses to identity for pure ASCII', () => {
  const p = byteOffsetsFor('SET x = 1;\nDECLARE y INTEGER;', 'utf8');
  assert.equal(p.identity, true);
  assert.equal(p.byte(5), 5);
  assert.equal(p.index(5), 5);
  assert.deepEqual(p.point(1, 8), { line: 1, character: 8 });
});

test('utf16 mode (the measured node-binding default) is the identity for any text', () => {
  const p = byteOffsetsFor("SET a = '你好é 😀';\nSET b = 2;", 'utf16');
  assert.equal(p.identity, true);
  const want = 29; // index of `b`
  assert.equal(p.index(p.byte(want)), want);
  assert.deepEqual(p.point(1, 4), { line: 1, character: 4 });
});
