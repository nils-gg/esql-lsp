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

export interface ScanResult {
  /** Same length and line structure as the input, comments/strings blanked. */
  masked: string;
  /** `masked` split the way an LSP client splits its own buffer, see `linesOf`. */
  lines: string[];
  /** The *unmasked* input, split the same way — for quoted names the mask blanks. */
  rawLines: string[];
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
          state = 'code';
        } else if (c === quote && n === quote) {
          // Escaped quote ('' or "").
          out[i] = ' ';
          out[i + 1] = ' ';
          i++;
        } else if (c === quote) {
          out[i] = ' ';
          state = 'code';
        } else {
          out[i] = ' ';
        }
        break;
      }
    }
  }

  const masked = out.join('');
  return { masked, lines: linesOf(masked), rawLines: linesOf(source) };
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
