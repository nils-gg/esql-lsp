/**
 * Lightweight ESQL scanner.
 *
 * Produces a "masked" version of the source in which the contents of all
 * comments and string literals are replaced by spaces. Offsets and line
 * structure are preserved exactly, so any Range computed on masked text maps
 * 1:1 onto the original document.
 *
 * All pattern-based analysis (diagnostics, symbols, completion context) runs
 * on masked text so that a `--` inside a string, a `BEGIN` inside a comment,
 * or a fake `END MODULE` inside a string literal cannot trigger false
 * positives. This is the core fix over the original esql-vscode extension,
 * whose `stripComment()` used a plain `indexOf('--')`.
 */

type State = 'code' | 'line-comment' | 'block-comment' | 'sq-string' | 'dq-string';

/**
 * A double-quoted ESQL identifier seen by the scanner as a first-class token
 * (list.md enhancement 20): where it sits AND what it names, normalized. In
 * ESQL `"…"` is always a quoted identifier (strings are `'…'`), so every
 * closed dq-string span is one. Consumers get the IDENTIFIER — a `"…"`
 * inside a comment or a `'…'` string never appears here, and `""` escapes
 * are collapsed exactly once (the old raw-line regexes got both wrong).
 */
export interface QuotedToken {
  /** The named thing, quotes removed, `""` → `"` (unquoteESQLName). */
  value: string;
  /** Row of the OPENING quote, client line conventions (linesOf). */
  line: number;
  /** Column of the opening quote. */
  startCol: number;
  /** Column just after the CLOSING quote. */
  endCol: number;
  /** Raw string-index span including the quotes: [from, to). */
  from: number;
  to: number;
}

export interface ScanResult {
  /** Same length and line structure as the input, comments/strings blanked. */
  masked: string;
  /** `masked` split the way an LSP client splits its own buffer, see `linesOf`. */
  lines: string[];
  /** The *unmasked* input, split the same way — for quoted names the mask blanks. */
  rawLines: string[];
  /** Every complete `"…"` identifier span, in source order. */
  quotedTokens: QuotedToken[];
}

/**
 * Split text into the lines an LSP client counts, without the terminators.
 *
 * `String#split('\n')` is not that: it leaves the `\r` of a CRLF file at the end
 * of every line (so a range built from `line.length` reaches one column past
 * where the client's line ends — ISSUES.md I-18), and it does not break at a
 * lone `\r` at all, which collapses a CR-only file onto line 0 and makes every
 * position meaningless (I-19). `vscode-languageserver-textdocument` — the model
 * behind `doc.getText(Range)` — breaks lines at `\r\n`, `\r` or `\n` and excludes
 * the terminator, so this matches the client.
 */
export function linesOf(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function scan(source: string): ScanResult {
  const out: string[] = new Array(source.length);
  let state: State = 'code';
  // Row accounting with linesOf's convention ('\n', or '\r' not before '\n')
  // so token columns are the columns an LSP client counts.
  let row = 0;
  let rowStart = 0;
  let qFrom = -1; // start of the open "…" identifier span, -1 outside one
  let qLine = 0;
  let qCol = 0;
  const quotedTokens: QuotedToken[] = [];

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const n = i + 1 < source.length ? source[i + 1] : undefined;

    switch (state) {
      case 'code':
        if (c === '-' && n === '-') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i++;
          state = 'line-comment';
        } else if (c === '/' && n === '*') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i++;
          state = 'block-comment';
        } else if (c === "'") {
          out[i] = ' ';
          state = 'sq-string';
        } else if (c === '"') {
          out[i] = ' ';
          qFrom = i;
          qLine = row;
          qCol = i - rowStart;
          state = 'dq-string';
        } else {
          out[i] = c;
        }
        break;

      case 'line-comment':
        // `\r` ends a line comment as surely as `\n` does — a client counts both
        // (see `linesOf`). Keeping only `\n` here blanked the rest of a CR-only
        // file, because the comment never appeared to end (ISSUES.md I-19). The
        // terminator itself is kept so the masked text has the same lines.
        if (c === '\n' || c === '\r') {
          out[i] = c;
          state = 'code';
        } else {
          out[i] = ' ';
        }
        break;

      case 'block-comment':
        if (c === '*' && n === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i++;
          state = 'code';
        } else {
          out[i] = c === '\n' || c === '\r' ? c : ' ';
        }
        break;

      case 'sq-string':
      case 'dq-string': {
        const quote = state === 'sq-string' ? "'" : '"';
        if (c === '\n' || c === '\r') {
          // ESQL string literals do not span lines; recover defensively.
          out[i] = c;
          qFrom = -1; // an unterminated "… is not an identifier token
          state = 'code';
        } else if (c === quote && n === quote) {
          // Escaped quote ('' or "").
          out[i] = ' ';
          out[i + 1] = ' ';
          i++;
        } else if (c === quote) {
          out[i] = ' ';
          if (quote === '"' && qFrom >= 0) {
            const raw = source.slice(qFrom, i + 1);
            quotedTokens.push({
              value: unquoteESQLName(raw),
              line: qLine,
              startCol: qCol,
              endCol: i + 1 - rowStart,
              from: qFrom,
              to: i + 1,
            });
          }
          qFrom = -1;
          state = 'code';
        } else {
          out[i] = ' ';
        }
        break;
      }
    }

    if (c === '\n' || (c === '\r' && n !== '\n')) {
      row++;
      rowStart = i + 1;
    }
  }

  const masked = out.join('');
  return { masked, lines: linesOf(masked), rawLines: linesOf(source), quotedTokens };
}

/**
 * Returns the start index of a standalone `BEGIN` keyword in the (masked)
 * line, or -1.
 */
export function findBeginToken(line: string): number {
  const m = /\bBEGIN\b/i.exec(line);
  return m ? m.index : -1;
}

/**
 * Returns the start index of a standalone `END` keyword in the (masked)
 * line, or -1. A standalone END is one not followed by IF | WHILE | FOR |
 * CASE | LOOP | MODULE | PROCEDURE | FUNCTION (those close their own blocks
 * and do not close a BEGIN block).
 */
export function findEndToken(line: string): number {
  const m = /\bEND\b/i.exec(line);
  if (!m) return -1;
  const rest = line.slice(m.index + m[0].length);
  if (/^\s*(IF|WHILE|FOR|CASE|LOOP|MODULE|PROCEDURE|FUNCTION)\b/i.test(rest)) {
    return -1;
  }
  return m.index;
}

export interface WordMatch {
  word: string;
  start: number;
  end: number;
}

/**
 * The name inside a quoted ESQL identifier: outer quotes removed, doubled
 * quotes collapsed to one (`"a""b"` → `a"b`) — the same escape convention
 * the string scanner above applies to `''`/`""`. Used by both extraction
 * paths so a quoted DECLARE produces the same name everywhere (G-5).
 */
export function unquoteESQLName(raw: string): string {
  const inner = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return inner.replace(/""/g, '"');
}

/**
 * The ESQL identifier under `character` in a (masked) line, or null. The
 * position just past the end of a word still counts, which is what LSP
 * clients report when the cursor sits at the end of a name.
 */
export function wordAt(line: string, character: number): WordMatch | null {
  const re = /[_a-zA-Z][_a-zA-Z0-9]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (character >= m.index && character <= m.index + m[0].length) {
      return { word: m[0], start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}
