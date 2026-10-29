/**
 * The ONE place that translates between the position spaces this server
 * juggles (list.md issue 1 / enhancement 18).
 *
 * There are THREE measurement systems in play, and node-tree-sitter 0.25.1
 * mixes two of them inside one node (measured 2026-10-28, see the probe
 * below):
 *
 *   - `startIndex`/`endIndex` are UTF-16 code units == JS string indices
 *     (the source reaches `ts_parser_parse_utf16`).
 *   - `startPosition.column`/`endPosition.column` are UTF-8 BYTE columns
 *     (tree-sitter core computes points by scanning bytes). A capture whose
 *     line holds é/你/好/😀 reported idx 68 with a 76-byte column — the two
 *     spaces disagree on every line containing non-ASCII.
 *   - LSP positions (and every pattern extractor here, which runs on JS
 *     strings) count UTF-16 code units.
 *
 * So this module's contract: `parser.ts` probes the loaded runtime once
 * (`setTreePositionEncoding`, measures BOTH halves) and consumers convert
 * through a `ByteOffsets` built over the document the tree was parsed from:
 * `point()` turns byte columns into character columns, `index()` covers
 * byte-offset spaces for bindings whose `startIndex` is bytes too. In the
 * shipped utf16-offset/byte-column regime the index conversions are the
 * identity and only point columns translate. Tree ranges must NEVER be
 * built from raw node offsets.
 *
 * The row convention matches `parse()`: lone `\r` is normalised to `\n`
 * before the tree sees it (same string index, same byte count either way),
 * `\r\n` ends at the same `\n` for both readers, so rows agree 1:1 with
 * the client's.
 */

/** What unit a loaded tree-sitter binding reports node offsets in. */
export type TreePositionEncoding = 'utf16' | 'utf8';

/**
 * 'points' when per-row `startPosition.column`s are UTF-8 byte columns.
 * Measured true for node-tree-sitter 0.25.1; the probe re-checks it.
 */
let pointColumnsAreBytes = true;
let indexEncoding: TreePositionEncoding = 'utf16';

/** Called by `parser.ts` after a successful grammar init. */
export function setTreePositionEncoding(encoding: TreePositionEncoding, bytePointColumns: boolean): void {
  indexEncoding = encoding;
  pointColumnsAreBytes = bytePointColumns;
}

export function treePositionEncoding(): TreePositionEncoding {
  return indexEncoding;
}

export function treePointColumnsAreBytes(): boolean {
  return pointColumnsAreBytes;
}

export class ByteOffsets {
  /** byteOf[i] = byte offset of string index i (only built when needed). */
  private readonly byteOf: Uint32Array;
  /** String index where each tree row starts (built when needed). */
  private readonly rowStarts: number[];
  /** True when every conversion returns its input. */
  readonly identity: boolean;

  /**
   * @param points mode of `startPosition.column`: defaults to the probed
   *        binding; @param indexes mode of `startIndex`. Tests pass both
   *        explicitly to exercise the translations.
   */
  constructor(
    text: string,
    points: TreePositionEncoding = pointColumnsAreBytes ? 'utf8' : 'utf16',
    indexes: TreePositionEncoding = indexEncoding
  ) {
    this.src = text;
    // Does anything actually need translating?
    let ascii = true;
    if (points === 'utf8' || indexes === 'utf8') {
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) >= 0x80) {
          ascii = false;
          break;
        }
      }
    }
    const needByteOf = indexes === 'utf8' && !ascii; // startIndex bytes -> string index
    const needRows = points === 'utf8' && !ascii; // byte columns -> char columns
    this.identity = !needByteOf && !needRows;
    if (this.identity) {
      this.byteOf = new Uint32Array(0);
      this.rowStarts = [];
      return;
    }
    this.byteOf = needByteOf ? ByteOffsets.buildByteTable(text) : new Uint32Array(0);
    this.rowStarts = needRows ? ByteOffsets.buildRowStarts(text) : [];
  }

  /** Parser-space offset of a string index (byte-indexed bindings only). */
  byte(stringIndex: number): number {
    if (this.byteOf.length === 0) return stringIndex;
    const i = Math.max(0, Math.min(stringIndex, this.byteOf.length - 1));
    return this.byteOf[i];
  }

  /** String index of a parser-space offset, floored to a codepoint boundary. */
  index(parserOffset: number): number {
    if (this.byteOf.length === 0) return parserOffset;
    const byteOf = this.byteOf;
    let lo = 0;
    let hi = byteOf.length - 1; // byteOf[length] = total bytes is the sentinel
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (byteOf[mid] <= parserOffset) lo = mid;
      else hi = mid - 1;
    }
    // A surrogate pair's two halves share one entry (only they ever repeat);
    // navigation must never stop on the low half, so floor to the start.
    if (lo > 0 && byteOf[lo] === byteOf[lo - 1]) lo -= 1;
    return lo;
  }

  /**
   * The LSP position a tree-sitter point means: same row (see the header
   * note), column converted from binding units to UTF-16 characters.
   */
  point(row: number, column: number): { line: number; character: number } {
    if (this.identity) return { line: row, character: column };
    return { line: row, character: this.pointColumn(row, column) };
  }

  /** Character column of a binding-space column on `row`. */
  pointColumn(row: number, column: number): number {
    if (this.identity) return column;
    const startStr = this.rowStart(row);
    // Byte column -> string offset within the row: walk the row's own text.
    const src = this.src;
    let i = startStr;
    let bytes = 0;
    while (i < src.length && bytes < column) {
      const c = src.charCodeAt(i);
      if (c === 10 || (c === 13 && src.charCodeAt(i + 1) !== 10)) break; // row edge
      if (c >= 0xd800 && c < 0xdc00) {
        bytes += 4;
        i += 2;
      } else if (c >= 0x800) {
        bytes += 3;
        i += 1;
      } else if (c >= 0x80) {
        bytes += 2;
        i += 1;
      } else {
        bytes += 1;
        i += 1;
      }
    }
    return i - startStr; // string indices == UTF-16 units
  }

  /** Convenience: both points of a node, in LSP space. */
  range(
    start: { row: number; column: number },
    end: { row: number; column: number }
  ): {
    start: { line: number; character: number };
    end: { line: number; character: number };
  } {
    return { start: this.point(start.row, start.column), end: this.point(end.row, end.column) };
  }

  /** {line, character} of a string index (client/LSP space). */
  positionOfStringIndex(stringIndex: number): { line: number; character: number } {
    if (this.rowStarts.length > 0) {
      // Reuse the row table: binary search for the last start <= index.
      let lo = 0;
      let hi = this.rowStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.rowStarts[mid] <= stringIndex) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo, character: stringIndex - this.rowStarts[lo] };
    }
    let row = 0;
    let lineStart = 0;
    for (let i = 0; i < stringIndex; i++) {
      const c = this.src.charCodeAt(i);
      if (c === 10 || (c === 13 && this.src.charCodeAt(i + 1) !== 10)) {
        row++;
        lineStart = i + 1;
      }
    }
    return { line: row, character: stringIndex - lineStart };
  }

  /** String index where tree row `row` begins. */
  rowStart(row: number): number {
    if (this.rowStarts.length > 0) return this.rowStarts[Math.min(row, this.rowStarts.length - 1)];
    // identity path: rows still break at '\n' and at a lone '\r'
    const src = this.src;
    let idx = 0;
    for (let r = 0; r < row; r++) {
      let i = idx;
      while (i < src.length) {
        const c = src.charCodeAt(i);
        if (c === 10 || (c === 13 && src.charCodeAt(i + 1) !== 10)) {
          i += 1;
          break;
        }
        i += 1;
      }
      idx = Math.min(i, src.length);
    }
    return idx;
  }

  /** byteOf table: string index -> byte offset, one entry per code unit. */
  private static buildByteTable(text: string): Uint32Array {
    const byteOf = new Uint32Array(text.length + 1);
    let bytes = 0;
    for (let i = 0; i < text.length; ) {
      byteOf[i] = bytes;
      const c = text.charCodeAt(i);
      if (c < 0x80) {
        bytes += 1;
        i += 1;
      } else if (c < 0x800) {
        bytes += 2;
        i += 1;
      } else if (c >= 0xd800 && c < 0xdc00) {
        // Surrogate pair = one 4-byte codepoint. BOTH halves carry an entry
        // (the 0-default of a gap would break the monotonicity the binary
        // search needs); sharing the pair's start keeps `index()` sound.
        byteOf[i + 1] = bytes;
        bytes += 4;
        i += 2;
      } else {
        bytes += 3;
        i += 1;
      }
    }
    byteOf[text.length] = bytes;
    return byteOf;
  }

  /** Row starts in string indices ('\n' and lone '\r' both end a row). */
  private static buildRowStarts(text: string): number[] {
    const rows: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) rows.push(i + 1);
    }
    return rows;
  }

  private readonly src: string;
}

/**
 * One converter per document text, memoized on the exact string plus the
 * modes it was built for. The parse cache already keys on text identity, so
 * this is the same discipline: build the tables once per distinct buffer
 * state, never per request.
 */
const memo = new Map<string, ByteOffsets>();

export function byteOffsetsFor(
  text: string,
  points?: TreePositionEncoding,
  indexes?: TreePositionEncoding
): ByteOffsets {
  const key = `${points ?? 'p'}${indexes ?? 'i'}\u0000${text}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const fresh = new ByteOffsets(text, points, indexes);
  if (memo.size > 32) {
    memo.delete(memo.keys().next().value as string); // FIFO, tiny LRU
  }
  memo.set(key, fresh);
  return fresh;
}
