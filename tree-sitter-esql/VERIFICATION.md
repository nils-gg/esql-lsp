# ESQL Grammar Verification

Every production in [`grammar.js`](grammar.js) is grounded in the **IBM ACE
12.0.x ESQL reference** (statement syntax diagrams and examples). This
document records the construct-by-construct evidence, the design
philosophy, the gaps found and fixed during the 2026-10-18/19 review
session, the verification results, and the known limitations.

## Design philosophy: permissive superset

The grammar is a **permissive superset** of the official railroad diagrams:

- **Everything in a railroad parses.** If the IBM syntax diagram accepts it,
  the grammar accepts it.
- **Small real-world deviations are tolerated** when the ACE ESQL compiler
  itself accepts them even though the railroad does not (see the `SET`
  `=`-clause note below).
- **Usage restrictions documented in prose are not enforced** (e.g. the spec
  note that `REPEAT` applies only to `PREVIOUSSIBLING`/`NEXTSIBLING`; parser
  domain names are not checked against a known list). Those belong in the
  LSP's semantic layer, not the parser.

Keyword handling is spec-driven: ESQL keywords are case-insensitive and may
be used as names *in field references* (but not as variable names); the
grammar exploits tree-sitter's context-sensitive keyword extraction to
implement exactly that (see the header comment in `grammar.js`).

## Construct → evidence table

Reference = the IBM ACE 12.0.x **ESQL Reference** ("ESQL statements /
expressions" pages with their syntax diagrams). Items marked ✓ were
re-verified against the live IBM documentation during the 2026-10-18/19
session; the others follow the reference syntax diagrams.

### File and module structure

| Construct (rule) | Evidence |
|---|---|
| `BROKER SCHEMA .mft.MySchema [PATH …] ;` (`broker_schema_statement`) | ESQL Reference, *BROKER SCHEMA* statement ✓ |
| `CREATE COMPUTE / DATABASE / FILTER MODULE … END MODULE` (`create_module_statement`) | ESQL Reference, *CREATE … MODULE* statement ✓ |
| Module-level `DECLARE` | *CREATE COMPUTE MODULE* diagram permits module-level declares ✓ |

### DECLARE

| Construct (rule) | Evidence |
|---|---|
| `DECLARE name[, name…] [SHARED \| EXTERNAL] datatype [initial value] ;` | *DECLARE* statement ✓ — initial value is a **bare expression** (docs example: `DECLARE source DECIMAL 31415.92653589;`); there is no `DEFAULT` keyword here |
| `DECLARE ref REFERENCE [TO] refname ;` | *DECLARE* statement, reference declaration ✓ |
| `DECLARE [name] CONSTANT ROW \| NAMEVALUE ;` | *DECLARE* statement ✓ |
| `NAMESPACE 'x' NAME 'y'` clauses | *DECLARE* statement ✓ |
| `INTERVAL year-to-month / day-to-hour / …` types (`_interval_qualifier`) | ESQL data types, INTERVAL ranges ✓ |
| Precision/length `CHAR(20)`, `DECIMAL(10,2)` | *Data types* diagrams ✓ |

### Control flow

| Construct (rule) | Evidence |
|---|---|
| `IF … THEN … [ELSEIF] … [ELSE] … END IF` | *IF* statement ✓ |
| `CASE source WHEN v THEN stmt… [ELSE] END CASE` (and sourceless form) | *CASE* statement ✓ |
| `WHILE … DO … END WHILE [label]`, `REPEAT … UNTIL e END REPEAT`, `LOOP … END LOOP` | *WHILE* / *REPEAT* / *LOOP* statements ✓ |
| `FOR i AS ref DO … END FOR` | *FOR* statement ✓ |
| Statement labels, `ITERATE l ;`, `LEAVE l ;` | *ITERATE* / *LEAVE* statements; label syntax in the flow-statement diagrams ✓ |
| `BEGIN [NOT] ATOMIC … END ;` | *BLOCK* statement ✓ |
| `RETURN [e] ;`, `RESIGNAL ;` | *RETURN* / *RESIGNAL* statements ✓ |

### Expressions

| Construct (rule) | Evidence |
|---|---|
| Operator ladder OR → AND → NOT → comparison → complex (`IN`, `BETWEEN [SYM\|ASY]METRIC`, `LIKE [NOT] … ESCAPE`, `IS [NOT] null-true-false-…`) → `\|\|` → `+ -` → `* /` → unary | *Expressions* precedence diagram ✓ |
| `IS +INF / -INF / INFINITY / -INFINITY / NAN / NUM / NUMBER` | *Expressions*, IS operators ✓ |
| `CASE WHEN/expr THEN … ELSE … END` expression | *Expressions*, CASE expression ✓ |
| `CAST (e [ , e … ] AS datatype [CCSID e] [ENCODING e] [FORMAT e] [DEFAULT e])` | *CAST* expression diagram ✓ (multi-argument form documented for decimal-precision casts) |
| `ROW (e [AS name] …)`, `LIST { e, … }` (curly braces) | *ROW* / *LIST* expression diagrams ✓ |
| `SELECT … FROM … [WHERE …]`, `SELECT *`, `SELECT ITEM`, aggregates `COUNT(*)/SUM/MAX/MIN`, `SELECT INSERT` | *Expressions*, SELECT expression ✓ |
| `EXISTS (…)`, `SINGULAR (…)`, `EXTRACT (unit FROM e)` | *EXISTS* / *SINGULAR* / *EXTRACT* expressions ✓ |
| Typed literals `DATE '…'`, `TIMESTAMP '…'`, `BIT '…'`, `INTERVAL '…' DAY TO HOUR`, … | *Expressions*, typed literals ✓ |
| `X'FF00'` blob literal, `''`-escaped strings, `"quoted"` identifiers | *Expressions* / identifier rules ✓ |
| Function call `f(a, …)`, `*` argument | *Expressions*, function-call form ✓ |

### Field references and message tree

| Construct (rule) | Evidence |
|---|---|
| `ref.Name`, index `[n]`, `[<n]`, `[>n]`, `[LAST]`, `[*]`, `[]` | *Field Reference* syntax summary ✓ |
| All name/namespace path forms: `*`, `:Name`, `:*`, `*:Name`, `*:*`, `Ns:Name`, `Ns:*`, `{expr}`, `"quoted"` | *Field Reference* syntax summary — lists exactly these forms; notes "`*:*` is equivalent to `*`" ✓ (the `*:` forms were gap **G4**, fixed in this session) |
| Type clause `ref.(XML.Element)Item`, `ref.(.Attribute)Title`, `ref.(XMLNS.Element)Value[1]` | *Field Reference* syntax summary — `(..)Name` / `(..)*` forms ✓ (was gap **G1**, fixed in this session) |
| `SET ref = e ;` and `SET ref [TYPE e] [NAMESPACE e] [NAME e] [VALUE e] ;` | *SET* statement ✓ — see permissive note below |
| `CREATE FIELD ref [AS var] [DOMAIN e] [REPEAT [VALUE e]] [TYPE/NAMESPACE/NAME/VALUE …] [IDENTITY (type)Ns:Name[n]] [FROM ref] [PARSE (…)]` | *CREATE FIELD* railroad: clause order AS → DOMAIN → REPEAT → (TYPE/NAMESPACE/NAME/VALUE) → FROM → PARSE ✓. `AS` takes a **variable/field reference**, not a string literal ✓ |
| `DELETE FIELD ref` / `DELETE (FIRST\|LAST)CHILD \| (NEXT\|PREVIOUS)SIBLING OF ref ;` | *DELETE FIELD* statement ✓ |
| `ATTACH ref TO ref AS FIRSTCHILD\|LASTCHILD\|NEXTSIBLING\|PREVIOUSSIBLING ;` | *ATTACH* statement ✓ |
| `DETACH ref ;` | *DETACH* statement ✓ |
| `MOVE ref TO ref \| PARENT \| FIRSTCHILD \| LASTCHILD \| NEXTSIBLING \| PREVIOUSSIBLING [clauses]` | *MOVE* statement ✓ |
| `PROPAGATE [TO TERMINAL e] [WHERE MESSAGE ref] [FINALIZE none] ;` | *PROPAGATE* statement ✓ |
| `PASSTHRU [ref \| (args)] [TO Database.ds] [VALUES (…)] ;` | *PASSTHRU* statement ✓ |

### Routines and exception handling

| Construct (rule) | Evidence |
|---|---|
| `CREATE FUNCTION / PROCEDURE name (params) [RETURNS datatype [NULLABLE\|NOT NULL]] [LANGUAGE …] [DYNAMIC RESULT SETS n]` | *CREATE FUNCTION / PROCEDURE* ✓ — `CONSTANT`/`SHARED` precede the datatype in a parameter ✓ |
| Parameter modes `IN / OUT / INOUT [CONSTANT] [SHARED]` | *CREATE FUNCTION*, parameter rules ✓ |
| `LANGUAGE ESQL\|JAVA\|CLR\|.NET [EXTERNAL NAME 'cls' [VERSION v \| ASSEMBLY a \| APPDOMAIN d \| CULTURE c \| PUBLICKEYTOKEN t \| CLASSLOADER cl]]` | *CREATE FUNCTION*, language/external-name diagrams ✓ |
| `CALL [BrokerSchema.]Routine (ParameterList) [IN Database.ds[.schema] \| EXTERNAL SCHEMA s] [INTO ref] ;` | *CALL* statement ✓ — the railroad makes `(ParameterList)` **required** (empty `()` allowed); `CALL r INTO x` *without* parens is not a documented form, and the grammar rejects it |
| `DECLARE CONTINUE\|EXIT HANDLER FOR SQLSTATE [VALUE \| LIKE 'x%' [ESCAPE c]], … ; stmt` | *DECLARE HANDLER* statement ✓ |
| `THROW USER EXCEPTION [SEVERITY n] [CATALOG e] [MESSAGE e] [VALUES (…)] ;` | *THROW USER EXCEPTION* statement ✓ |
| `LOG EVENT\|USER TRACE [FULL] [SEVERITY n] [MESSAGE e] [EXCEPTION] [VALUES (…)] ;` | *LOG* statement ✓ |
| `EVAL ('…') ;` | *EVAL* statement ✓ |

### Database statements

| Construct (rule) | Evidence |
|---|---|
| `INSERT INTO Database[.ds][.schema].table [(cols)] VALUES (…) [WHERE e] ;` (dynamic `{expr}` parts) | *INSERT* statement ✓ |
| `UPDATE Database… SET e, … [AS corr] [WHERE e] ;` | *UPDATE* statement ✓ |
| `DELETE FROM Database… [AS corr] [WHERE e] ;` | *DELETE* statement ✓ |

## Gaps found and fixed (2026-10-18/19 review session)

| ID | Gap | Fix | Regression test |
|---|---|---|---|
| **G1** | Field-reference **type clause** `ref.(XML.Element)Item` was not parseable — `_type_clause` was missing entirely | Added `_type_clause` / `_type_clause_part` (at most two dotted parts, optional leading dot for the notarget form) to the field-reference production | `message_tree.txt` → "field reference type clause (G1 regression)" |
| **G2** | `SET ref TYPE = e` / `NAMESPACE = e` / `NAME = e` rejected — the official railroad shows `=` only after `VALUE`, but the ACE compiler accepts `=` after the other named clauses too | New `_set_clause_value = choice(expression, seq('=', expression))` used by all four named SET clauses (permissive superset) | `message_tree.txt` → "set named clauses with equals (G2 regression)" |
| **G4** | Wildcard path forms `*:*` and `*:Name` rejected (`*` was not allowed as a namespace/name part) | `_path_name` reworked with `_path_name_any = choice('*', part)` | `message_tree.txt` → "field reference namespaces and wildcards" (includes `:*`, `*:*`, `*:Name2`) |

Items investigated and confirmed to be **test-sample errors, not grammar bugs**
(the grammar correctly rejects them per the reference):

- `RETURNS DATAOBJECT` — `DATAOBJECT` is a parser *domain*, not a datatype.
- `DECLARE x INT DEFAULT 10` — no `DEFAULT` keyword; the initial value is a
  bare expression.
- `CREATE FIELD … AS 'string'` — `AS` takes a variable/field reference.
- Combined single-statement `SET ref = TYPE e NAMESPACE e NAME e` — the
  `=`-value and named-clause forms are separate alternatives.
- `CREATE FIELD … DATE …` — no `DATE` clause in the railroad.
- `DECLARE x INT DEFAULT 10` is rejected because `DEFAULT` is consumed as
  the bare initial-value expression and the trailing `10` dangles (there is
  no `DEFAULT` keyword in `DECLARE`).

## Verification results (2026-10-19)

- `tree-sitter generate` — no LR conflicts beyond the declared
  `conflicts` list; `parser.c` / `grammar.json` / `node-types.json`
  regenerated.
- `tree-sitter test` — **71/71 corpus tests pass** across 8 files
  (`basics`, `declares`, `control_flow`, `expressions`, `message_tree`,
  `routines`, `exceptions`, `database`); no `ERROR` or `MISSING` nodes in any
  expectation.
- `queries/highlights.scm` compiles and produces sensible captures
  (verified via `tree-sitter test` query validation and through the npm
  runtime: keyword/keyword.control/type/variable/function.definition/
  function.call/parameter/module/string/number/operator captures on a
  representative module).
- Node binding: `npm install` in `tree-sitter-esql/` builds the N-API addon
  from `binding.gyp`; `bindings/node/binding_test.js` passes; an end-to-end
  smoke test (parse + `highlights` query through the `tree-sitter` npm
  runtime) returns 0 error nodes on G1/G2/G4 regression snippets.

## Unadjudicated construct gaps (2026-10-23 LSP session)

While building LSP fixtures and tests, these constructs were found to be
**rejected by the current grammar** (each verified by parsing it and observing an
`ERROR` node). They are listed as *open questions*, not as bugs: none has been
compared against the IBM railroad diagram yet, and per the ground rule the
reference — not the test suite, and not real-world code alone — decides whether
the grammar or the fixture is wrong. Each row says what the grammar does today,
so adjudication starts from a known state.

| Construct | Today | Why it happens in the grammar |
|---|---|---|
| `COPY PropertyTree.InputCopy;` / `COPY … TO ref;` | rejected | no `copy_statement` production at all (not in `esql_statement`) |
| `SELECT … INTO OutputRoot… FROM …` | rejected | `SELECT` exists **only as an expression** (`SET x = SELECT … FROM …`); there is no `select_statement`, so the `INTO` form cannot parse. Correlating with an alias inside the expression form needs `AS` (`FROM Data.Item AS I`) ✓ corpus-covered |
| `LOG TERMINAL 'out';` | rejected | `log_statement` requires `LOG EVENT` / `LOG USER TRACE` **and** a `VALUES (…)` clause; `LOG EVENT;` without `VALUES` is rejected too |
| `ELSE IF cond THEN` (two tokens) | rejected | `if_statement` offers `ELSEIF` or `ELSE`-then-statements; no `ELSE` + nested-`IF` alternative |
| `BEGIN ATOMIC … END;` | rejected | `block_statement` allows only `BEGIN [NOT] ATOMIC` |
| `DECLARE nums LIST OF INTEGER;` | rejected | the datatype production has no `LIST OF`; the `LIST{…}` literal is reachable as an expression only |
| `CALL AddTwo(IN a, OUT b);` | rejected | `call_statement` arguments are plain expressions; mode keywords are only modelled on `CREATE PROCEDURE/FUNCTION` parameter declarations |
| `CREATE FUNCTION F() RETURNS INTEGER DETERMINISTIC` / `NO SQL` | rejected | `create_routine_statement` models `LANGUAGE …` and `DYNAMIC RESULT SETS n` but not the DB2 routine-characteristic set (`[NOT] DETERMINISTIC`, `NO SQL`, `READS SQL DATA`, `MODIFIES SQL DATA`) |

Adjudicating any of them means: read the railroad for that statement in the IBM
ACE 12.0.x ESQL reference, extend `grammar.js` (permissive superset, never
stricter), add a corpus test, and re-run both suites (`npm run grammar:test` and
root `npm test`).

## Known limitations (backlog)

1. **SQL-style function clause forms** — `SUBSTRING(s FROM 1 FOR 2)` and
   `TRIM(BOTH x FROM y)` (and their cousins) are documented ESQL but the
   grammar only accepts the plain call form `SUBSTRING(s, 1, 2)` /
   `TRIM(x, y)`. Corpus tests deliberately avoid the clause forms.
2. **No semantic validation** — parser domains, CCSIDs, terminal names and
   other string-valued clauses are not checked against known values
   (by design; permissive superset).
3. **`OPTIONS` / named `PARSE` clauses** are accepted as expression lists
   without per-parser option-name validation.
4. **No type-inference layer** — e.g. it is not checked that a `TYPE`
   expression is a string constant; the LSP's semantic layer owns those
   diagnostics.
5. **Out-of-order `CONSTANT` in routine parameters is silently accepted** —
   `IN a DECIMAL(5,2) CONSTANT` (valid order: `IN a CONSTANT DECIMAL(5,2)`)
   parses with `CONSTANT` read as a field-reference name, because keywords
   are name-legal in field-reference positions by design (the slot also
   serves as the `REFERENCE TO …` target). The LSP's semantic layer should
   flag the parameter order.
