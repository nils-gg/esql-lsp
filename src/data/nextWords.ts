/**
 * Clause-aware "next word" completion table.
 *
 * A rule fires when the MASKED line prefix — everything on the cursor line
 * before the word currently being typed — matches its `pattern`, and then the
 * completion list narrows to the words that can legally stand at that position.
 * Every word list is taken from `tree-sitter-esql/grammar.js` (the ACE 12.0.x
 * railroad diagrams), so grammar mode and heuristic mode narrow identically —
 * this table is a pure prefix analysis and never consults the parse tree.
 *
 * FIRST MATCH WINS, so more specific patterns must sit above the generic ones
 * that could also match their prefix (e.g. `PROPAGATE … DELETE` before the
 * statement-level `DELETE`). Patterns that name a statement keyword anchor it
 * at line start (the only line the completion sees); patterns that end on a
 * clause keyword (`AS`, `TO`, `HANDLER`) stay unanchored because those words
 * appear in one clause shape only.
 *
 * Deliberately absent — MQSC, not ESQL: `DEFINE` with `QLOCAL` / `QALIAS` /
 * `CHANNEL` is IBM MQ's queue-manager command language (`runmqsc`). Neither
 * IBM's ESQL reserved/non-reserved keyword pages (ACE 12.0.x) nor the railroad
 * diagrams carry a DEFINE statement, and the grammar here parses it as an
 * ERROR, so completing it would offer text the ESQL Toolkit cannot compile.
 *
 * Documented approximation: rules see the CURRENT line only — like every other
 * completion context in this server — so a clause continued on a following
 * line falls back to the general list rather than being narrowed wrong.
 */

import { ESQL_TYPES } from './esqlData';

export interface NextWordRule {
  /** Stable id; appears in tests and in the item detail text. */
  id: string;
  /**
   * Tested against the masked line prefix BEFORE the word being typed. Every
   * pattern must end at an explicit boundary — a whitespace run plus end of
   * prefix, or an open paren — so a half-typed word can only filter the list,
   * never extend what is valid there.
   */
  pattern: RegExp;
  /** Clause keywords offered at this position. */
  words: string[];
  /** Words offered as documented data types (ESQL_TYPES docs). */
  types?: string[];
  /** Shared detail for the keyword words; a type word uses its own doc. */
  detail: string;
  /**
   * true: offer the rule's words AND the general list (a position where a
   * keyword may continue the clause but an expression is also legal — e.g.
   * after `BETWEEN`, where ASYMMETRIC/SYMMETRIC are optional). Default false:
   * the clause position admits only the listed words.
   */
  additive?: boolean;
}

const ALL_TYPES = ESQL_TYPES.map((t) => t.name);

/** Same clause words wherever `CREATE FIELD ref` / `CREATE <dir> OF ref` may continue. */
const CREATE_TARGET_WORDS = [
  'AS', 'DOMAIN', 'FROM', 'IDENTITY', 'NAME', 'NAMESPACE', 'PARSE', 'REPEAT', 'TYPE', 'VALUE',
];

/** The `IS [NOT]` value set of the complex comparison operators. */
const IS_VALUE_WORDS = [
  'NULL', 'TRUE', 'FALSE', 'UNKNOWN', 'INF', 'INFINITY', 'NAN', 'NUM', 'NUMBER',
];

/** Datetime units accepted by `EXTRACT(<unit> FROM …)`. */
const EXTRACT_UNIT_WORDS = [
  'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'DAYS', 'DAYOFYEAR',
  'DAYOFWEEK', 'MONTHS', 'QUARTEROFYEAR', 'QUARTERS', 'WEEKS', 'WEEKOFYEAR',
  'WEEKOFMONTH', 'ISLEAPYEAR',
];

const TREE_DIRECTION_WORDS = [
  'FIRSTCHILD', 'LASTCHILD', 'PREVIOUSSIBLING', 'NEXTSIBLING',
];

export const NEXT_WORD_RULES: NextWordRule[] = [
  // ── Module / schema header ────────────────────────────────────────────────
  {
    id: 'broker-schema',
    pattern: /^[ \t]*BROKER\s+$/i,
    words: ['SCHEMA'],
    detail: 'BROKER SCHEMA names the message set this .esql file belongs to',
  },

  // ── CREATE ────────────────────────────────────────────────────────────────
  {
    id: 'create-target-clauses',
    pattern: /^[ \t]*CREATE\s+(?:FIELD\s+|FIRSTCHILD\s+OF\s+|LASTCHILD\s+OF\s+|NEXTSIBLING\s+OF\s+|PREVIOUSSIBLING\s+OF\s+)[^=;\s]+\s+$/i,
    words: CREATE_TARGET_WORDS,
    detail: 'continues CREATE FIELD / CREATE <direction> OF',
  },
  {
    id: 'create-module-type',
    pattern: /^[ \t]*CREATE\s+(?:COMPUTE|DATABASE|DATABASEEVENT|FILTER)\s+$/i,
    words: ['MODULE'],
    detail: 'the module kind is always followed by MODULE',
  },
  {
    id: 'create-direction-of',
    pattern: /^[ \t]*CREATE\s+(?:FIRSTCHILD|LASTCHILD|NEXTSIBLING|PREVIOUSSIBLING)\s+$/i,
    words: ['OF'],
    detail: 'CREATE <direction> always takes OF <reference>',
  },
  {
    id: 'create-statement',
    pattern: /^[ \t]*CREATE\s+$/i,
    words: [
      'COMPUTE', 'DATABASE', 'DATABASEEVENT', 'FIELD', 'FILTER',
      'FIRSTCHILD', 'FUNCTION', 'LASTCHILD', 'NEXTSIBLING',
      'PREVIOUSSIBLING', 'PROCEDURE',
    ],
    detail: 'opens a module, routine or message-tree element',
  },

  // ── DECLARE family (the bare `DECLARE <name>` form is the `types` context) ─
  {
    id: 'declare-handler-for',
    pattern: /^[ \t]*DECLARE\s+(?:CONTINUE|EXIT)\s+HANDLER\s+$/i,
    words: ['FOR'],
    detail: 'DECLARE <kind> HANDLER always handles FOR SQLSTATE',
  },
  {
    id: 'declare-handler-sqlstate',
    pattern: /^[ \t]*DECLARE\s+(?:CONTINUE|EXIT)\s+HANDLER\s+FOR\s+$/i,
    words: ['SQLSTATE'],
    detail: 'SQLSTATE is the only condition list ESQL handlers match',
  },
  {
    id: 'declare-handler-condition',
    pattern: /^[ \t]*DECLARE\s+(?:CONTINUE|EXIT)\s+HANDLER\s+FOR\s+SQLSTATE\s+$/i,
    words: ['VALUE', 'LIKE'],
    detail: 'each SQLSTATE entry is a bare value, VALUE \'…\' or LIKE \'…\'',
  },
  {
    id: 'declare-handler-keyword',
    pattern: /^[ \t]*DECLARE\s+(?:CONTINUE|EXIT)\s+$/i,
    words: ['HANDLER'],
    detail: 'CONTINUE / EXIT declare a HANDLER',
  },
  {
    id: 'declare-types',
    // After the name list and any SHARED/EXTERNAL/CONSTANT flags the datatype
    // is next; NAMESPACE/NAME double as the alias clauses that follow it.
    pattern: /^[ \t]*DECLARE\s+(?:[A-Za-z_]\w*\s*,\s*)*[A-Za-z_]\w*(?:\s+(?:SHARED|EXTERNAL|CONSTANT))*\s+$/i,
    words: ['SHARED', 'EXTERNAL', 'CONSTANT', 'NAME'],
    types: ALL_TYPES,
    detail: 'declares the variable’s datatype or flags',
  },

  // ── Blocks / control flow ─────────────────────────────────────────────────
  {
    id: 'end-block',
    pattern: /^[ \t]*END\s+$/i,
    words: ['MODULE', 'IF', 'CASE', 'WHILE', 'REPEAT', 'LOOP', 'FOR'],
    detail: 'END closes a labelled block; a plain END takes no word',
  },
  {
    id: 'for-as',
    pattern: /^[ \t]*FOR\s+[A-Za-z_]\w*\s+$/i,
    words: ['AS'],
    detail: 'FOR <correlation> AS <field reference> DO',
  },
  {
    id: 'for-do',
    pattern: /^[ \t]*FOR\s+[A-Za-z_]\w*\s+AS\s+[^=;\s]+\s+$/i,
    words: ['DO'],
    detail: 'FOR … AS <reference> opens its body with DO',
  },

  // ── SET (statement start; the `SET ref = expr` value position stays general)
  {
    id: 'set-clauses',
    // The single token before the cursor is the field reference; `=` is
    // excluded so `SET x = ` is recognised as the general expression position.
    pattern: /^[ \t]*SET\s+[^=;\s]+\s+$/i,
    words: ['=', 'TYPE', 'NAMESPACE', 'NAME', 'VALUE'],
    detail: 'SET <reference> assigns with = or takes TYPE/NAMESPACE/NAME/VALUE clauses',
  },

  // ── Message-tree manipulation ─────────────────────────────────────────────
  {
    id: 'delete-direction-of',
    pattern: /^[ \t]*DELETE\s+(?:FIRSTCHILD|LASTCHILD|NEXTSIBLING|PREVIOUSSIBLING)\s+$/i,
    words: ['OF'],
    detail: 'DELETE <direction> always takes OF <reference>',
  },
  {
    id: 'delete-from',
    pattern: /^[ \t]*DELETE\s+FROM\s+$/i,
    words: ['DATABASE'],
    detail: 'DELETE FROM <Database.dsn.schema.table>',
  },
  {
    id: 'delete-statement',
    pattern: /^[ \t]*DELETE\s+$/i,
    words: ['FIELD', ...TREE_DIRECTION_WORDS, 'FROM'],
    detail: 'DELETE removes FIELD/<direction> OF <ref> or FROM a table',
  },
  {
    id: 'attach-as',
    pattern: /^[ \t]*ATTACH\s+[^=;\s]+\s+TO\s+[^=;\s]+\s+$/i,
    words: ['AS'],
    detail: 'ATTACH <source> TO <target> always says AS <position>',
  },
  {
    id: 'attach-to',
    pattern: /^[ \t]*ATTACH\s+[^=;\s]+\s+$/i,
    words: ['TO'],
    detail: 'ATTACH <source> TO <target>',
  },
  {
    id: 'attach-position',
    pattern: /^[ \t]*ATTACH\b[^;]*\bAS\s+$/i,
    words: TREE_DIRECTION_WORDS,
    detail: 'the ATTACH position is a tree direction',
  },
  {
    id: 'move-direction-clauses',
    pattern: /^[ \t]*MOVE\s+[^=;\s]+\s+(?:PARENT|FIRSTCHILD|LASTCHILD|PREVIOUSSIBLING|NEXTSIBLING)\s+$/i,
    words: ['IDENTITY', 'NAME', 'NAMESPACE', 'REPEAT', 'TYPE'],
    detail: 'MOVE <ref> <direction> takes TYPE/NAMESPACE/NAME/IDENTITY/REPEAT clauses',
  },
  {
    id: 'move-target',
    pattern: /^[ \t]*MOVE\s+[^=;\s]+\s+$/i,
    words: ['TO', 'PARENT', 'FIRSTCHILD', 'LASTCHILD', 'PREVIOUSSIBLING', 'NEXTSIBLING'],
    detail: 'MOVE <reference> goes TO a place or takes a tree direction',
  },

  // ── PROPAGATE ─────────────────────────────────────────────────────────────
  {
    id: 'propagate-finalize',
    pattern: /^[ \t]*PROPAGATE\b[^;]*\bFINALIZE\s+$/i,
    words: ['DEFAULT', 'NONE'],
    detail: 'FINALIZE takes DEFAULT or NONE',
  },
  {
    id: 'propagate-delete',
    pattern: /^[ \t]*PROPAGATE\b[^;]*\bDELETE\s+$/i,
    words: ['DEFAULT', 'NONE'],
    detail: 'PROPAGATE DELETE takes DEFAULT or NONE',
  },
  {
    id: 'propagate-to',
    pattern: /^[ \t]*PROPAGATE\s+TO\s+$/i,
    words: ['TERMINAL', 'LABEL'],
    detail: 'PROPAGATE TO picks a TERMINAL or a LABEL',
  },
  {
    id: 'propagate-statement',
    pattern: /^[ \t]*PROPAGATE\s+$/i,
    words: ['TO', 'WHERE', 'ENVIRONMENT', 'MESSAGE', 'EXCEPTION', 'FINALIZE', 'DELETE'],
    detail: 'PROPAGATE routes with TO and copies ENVIRONMENT/MESSAGE/EXCEPTION trees',
  },

  // ── Logging and exceptions ────────────────────────────────────────────────
  {
    id: 'log-user-trace',
    pattern: /^[ \t]*LOG\s+USER\s+$/i,
    words: ['TRACE'],
    detail: 'LOG USER TRACE logs a user trace entry',
  },
  {
    id: 'log-options',
    pattern: /^[ \t]*LOG\s+(?:EVENT|USER\s+TRACE)(?:\s+(?:FULL|EXCEPTION|SEVERITY|CATALOG|MESSAGE)\b[^=;()]*)?\s+$/i,
    words: ['CATALOG', 'EXCEPTION', 'FULL', 'MESSAGE', 'SEVERITY', 'VALUES'],
    detail: 'LOG … takes FULL/EXCEPTION/SEVERITY/CATALOG/MESSAGE before VALUES ( … )',
  },
  {
    id: 'log-statement',
    pattern: /^[ \t]*LOG\s+$/i,
    words: ['EVENT', 'USER'],
    detail: 'LOG writes an EVENT or a USER TRACE',
  },
  {
    id: 'throw-exception-clauses',
    pattern: /^[ \t]*THROW\s+USER\s+EXCEPTION(?:\s+(?:SEVERITY|CATALOG|MESSAGE)\b[^=;()]*)?\s+$/i,
    words: ['CATALOG', 'MESSAGE', 'SEVERITY', 'VALUES'],
    detail: 'THROW … EXCEPTION takes SEVERITY/CATALOG/MESSAGE and optional VALUES ( … )',
  },
  {
    id: 'throw-user',
    pattern: /^[ \t]*THROW\s+USER\s+$/i,
    words: ['EXCEPTION'],
    detail: 'THROW always raises a USER EXCEPTION',
  },
  {
    id: 'throw-statement',
    pattern: /^[ \t]*THROW\s+$/i,
    words: ['USER'],
    detail: 'THROW always raises a USER EXCEPTION',
  },

  // ── Database statements ───────────────────────────────────────────────────
  {
    id: 'passthru-to',
    pattern: /^[ \t]*PASSTHRU\b[^;]*\bTO\s+$/i,
    words: ['DATABASE'],
    detail: 'PASSTHRU … TO <Database.datasource>',
  },
  {
    id: 'insert-into',
    pattern: /^[ \t]*INSERT\s+INTO\s+$/i,
    words: ['DATABASE'],
    detail: 'INSERT INTO <Database.dsn.schema.table>',
  },
  {
    id: 'insert-statement',
    pattern: /^[ \t]*INSERT\s+$/i,
    words: ['INTO'],
    detail: 'INSERT always takes INTO <table>',
  },
  {
    id: 'update-table',
    pattern: /^[ \t]*UPDATE\s+$/i,
    words: ['DATABASE'],
    detail: 'UPDATE <Database.dsn.schema.table>',
  },

  // ── Routine header tail ───────────────────────────────────────────────────
  {
    id: 'routine-external-name',
    // `DECLARE x EXTERNAL` is narrowed by declare-types above, which wins the
    // first-match race; what is left here is the routine header's EXTERNAL NAME.
    pattern: /\bEXTERNAL\s+$/i,
    words: ['NAME'],
    detail: 'EXTERNAL NAME "java.library(class)" declares an external routine',
  },
  {
    id: 'routine-language',
    pattern: /\bLANGUAGE\s+$/i,
    words: ['ESQL', 'DATABASE', 'JAVA', 'CLR'],
    detail: 'LANGUAGE picks the routine implementation language (.NET is written `.NET`)',
  },

  // ── Expression clause words ───────────────────────────────────────────────
  {
    id: 'cast-as',
    pattern: /\bCAST\s*\([^()]*\bAS\s+$/i,
    words: [],
    types: ALL_TYPES,
    detail: 'CAST ( … AS <datatype> [CCSID/ENCODING/FORMAT/DEFAULT …] )',
  },
  {
    id: 'extract-unit-from',
    pattern: /\bEXTRACT\s*\(\s*(?:YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|DAYS|DAYOFYEAR|DAYOFWEEK|MONTHS|QUARTEROFYEAR|QUARTERS|WEEKS|WEEKOFYEAR|WEEKOFMONTH|ISLEAPYEAR)\s+$/i,
    words: ['FROM'],
    detail: 'EXTRACT (<unit> FROM <datetime>)',
  },
  {
    id: 'extract-unit',
    pattern: /\bEXTRACT\s*\(\s*$/i,
    words: EXTRACT_UNIT_WORDS,
    detail: 'EXTRACT takes a datetime unit before FROM',
  },
  {
    id: 'trim-direction',
    pattern: /\bTRIM\s*\(\s*(?:BOTH|LEADING|TRAILING)\s+$/i,
    words: ['FROM'],
    additive: true, // the characters-to-trim expression may come first
    detail: 'TRIM(<dir> [chars FROM] <string>)',
  },
  {
    id: 'trim-paren',
    pattern: /\bTRIM\s*\(\s*$/i,
    words: ['BOTH', 'LEADING', 'TRAILING'],
    detail: 'TRIM([BOTH|LEADING|TRAILING] …)',
  },
  {
    id: 'is-not-values',
    pattern: /\bIS\s+NOT\s+$/i,
    words: IS_VALUE_WORDS,
    detail: 'IS NOT <value> — the comparison value set',
  },
  {
    id: 'is-values',
    // A path segment `.IS` is a field name, not the operator; `SET IS ` is the
    // SET target position (its own anchored rule wins the race above).
    pattern: /(?:^|[^A-Za-z0-9_.])IS\s+$/i,
    words: ['NOT', ...IS_VALUE_WORDS],
    detail: 'IS [NOT] <value> — the comparison value set',
  },
  {
    id: 'between-qualifier',
    pattern: /\bBETWEEN\s+$/i,
    words: ['ASYMMETRIC', 'SYMMETRIC'],
    additive: true, // the lower bound expression is equally legal here
    detail: 'BETWEEN [ASYMMETRIC|SYMMETRIC] <low> AND <high>',
  },
];
