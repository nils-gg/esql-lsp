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
  /** `masked` split on newlines. */
  lines: string[];
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
        if (c === '\n') {
          out[i] = '\n';
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
          out[i] = c === '\n' ? '\n' : ' ';
        }
        break;

      case 'sq-string':
      case 'dq-string': {
        const quote = state === 'sq-string' ? "'" : '"';
        if (c === '\n') {
          // ESQL string literals do not span lines; recover defensively.
          out[i] = '\n';
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
  return { masked, lines: masked.split('\n') };
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
