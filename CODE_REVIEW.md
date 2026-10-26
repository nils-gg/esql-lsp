# Code review — completion, go-to-definition, error messages, rename

**Rev 3, 2026-10-25.** Independently re-derived against the **current working
tree** (commit `0d5191d` + the uncommitted clause-aware completion work:
`src/data/nextWords.ts`, its wiring in `src/completion.ts`, and
`test/completion.test.ts`). This rev replaces the rev-2 file that sat here
(backup: `/tmp/opencode/esql-review-3/CODE_REVIEW-rev2-backup.md`); every
finding below was re-measured from scratch with a **fresh fixture workspace
and probe harness**, not carried over: `/tmp/opencode/esql-review-3/`
(`probe.js`, fixtures under `ws/`, reports `report-{grammar,heuristic}.json`).
Rev-2 claims that survived re-derivation are kept and marked as such; new
findings are marked ★.

Suite state at review time:

| Command | Result |
|---|---|
| `npm test` | 140 pass / **1 fail** — see T-1 (the code is right, the test is wrong) |
| `ESQL_LSP_NO_GRAMMAR=1 npm test` | 109 pass / 1 fail (same) / 31 skip |
| `npm run grammar:test` | 85 / 85 corpus cases ✓ |

## Executive summary — the four questions

| Question | Verdict |
|---|---|
| **Is completion "smart" — does it suggest words that can/must come next?** | **Partly, and genuinely so where it acts.** The (uncommitted) next-word table really does narrow to legal continuations at 46 clause positions — `SET x␣` → exactly `= TYPE NAMESPACE NAME VALUE`, `PROPAGATE TO␣` → `TERMINAL LABEL`, `CAST(… AS␣` → datatypes only, `END␣` → the seven block words — identically in both modes, string-mask-safe (verified live). But **no user-defined routine is ever offered** (`CALL Helper` → nothing; not even the file's own `Main`), workspace `SHARED` names are never offered, the server prefix-prunes candidates *before* the client's fuzzy matcher can see them, and every snippet arrives as PlainText so `${1:…}` placeholders are inserted literally. |
| **Does go-to-definition work, even between files?** | **Within one file, yes and correctly** (variables at read *and* write positions, parameters incl. multi-line headers, routines, module names, cursor-on-declaration stays, built-ins and tree-path elements answer nothing). **Between files: no.** A `CALL` to a routine in a sibling file, or a use of a sibling's `SHARED` variable, returns `null` — in *both* modes, with the workspace index warm and even with the declaring file closed. References and hover stop at the same boundary. Worse: find-references on a cross-file `SHARED` name returns `[]` **even for the uses inside the current file** (G-3). Quoted-name declarations resolve in heuristic mode but **regress in grammar mode** (G-5). |
| **Are the error messages descriptive (ELM-style)?** | **About half, with two serious flaws.** Every diagnostic carries a stable code + docs link; several messages are genuinely ELM-shaped (what + why + the fix, e.g. the Properties hint quoting the statement to write). But a bare `Syntax error.` still ships for common typos with zero information; one missing `;` at file level collapses the *whole file* into a single error **and silently kills declaration extraction** (E-2); the grammar false-flags the legacy `LOGICAL` type with a misleading "expected a data type" error (E-3); unknown `CALL` targets and undeclared *reads* are never flagged; and there is no `codeAction`/quickfix layer, so no "fix it for me" anywhere. |
| **Does rename work — cross-file, incl. third files?** | **No — rename is not implemented at all.** No `renameProvider` capability; `textDocument/rename` and `prepareRename` answer `Unhandled method` (-32601), re-verified in both modes. Editors grey the action out. Third-file renaming additionally needs two things that don't exist yet: cross-file references and *located* workspace facts (today `SHARED` names are indexed as name strings only, with no URI/range). |

---

## 1. Completion — "smart"?

### What is genuinely good (verified live, both modes identical)

The uncommitted `NEXT_WORD_RULES` mechanism is the right design: pure masked
prefix analysis → first-match-wins rule table, so both parse modes narrow
alike and a `'END '` inside a string never opens a clause (probe: rule for
`SET s = 'END ` → none). Measured:

| Cursor at | Items offered |
|---|---|
| `SET cnt␣` | exactly `=` `TYPE` `NAMESPACE` `NAME` `VALUE` (5) |
| `PROPAGATE TO␣` | `TERMINAL` `LABEL` (2) |
| `CREATE␣` | the 11 CREATE kinds |
| `DECLARE x SHARED␣` | flags + 14 datatypes, nothing else (18) |
| `DECLARE zz␣` | `CONSTANT` + 14 datatypes (15) |
| `SET y = CAST(z AS␣` | the 14 datatypes only |
| `SET y = EXTRACT(` | the 15 datetime units |
| `END␣` | `MODULE IF CASE WHILE REPEAT LOOP FOR` (7) |
| `InputRoot.` | the 12 domains |
| `LOG USER␣` / `INSERT␣` / `THROW␣` | `TRACE` / `INTO` / `USER` (1 each) |
| half-typed `SET cnt TYP` | exactly `TYPE` |

Also good: scope-correct declared names are offered (`cnt` in scope appears;
out-of-scope routine bodies are filtered — I-16 machinery), one item per label
with kind-preference dedupe, IF-keyword vs if-snippet distinction preserved,
trigger characters `.`, `(`, ` ` set so the narrowing fires as you type.

### Findings

**C-1 (high) — user routines are never completable.** After `CALL␣` the list
is the unfiltered general dump (243 items); neither the file's own routines
(`Main` absent from the general list) nor sibling-file routines
(`Helper` never appears) are offered. Routines live in
`analysis.routines` / `routinesFromSource()` and in the workspace index —
`buildCompletionItems()` simply never receives them. This is the single most
requested "smart" item for ESQL (`CALL`, and routine names in expressions).

**C-2 (high) — workspace `SHARED` variables never completable.** A
`DECLARE … SHARED` in any file is exactly the name you type everywhere;
`FailureCount` appears in no list. The names are already in the index
(`sharedNamesFromDisk`) — completion just doesn't consult it.

**C-3 (medium) — the server prunes by prefix before the client can fuzzy-match.**
`filterByPrefix()` filters `startsWith(wordBeingTyped)` server-side and items
carry no `filterText`. Clients that do subsequence/fuzzy ranking (nvim-cmp,
copilot-lsp, VS Code itself) never see the candidates they could have matched
transposed-typing away. The protocol's intent is: send the context-relevant
set, let the client filter. The clause table already gives the context cut;
the prefix cut should move to `filterText`.

**C-4 (medium) — snippets are delivered as PlainText.** `snippetItems()`
(`src/completion.ts:147-154`) sets `insertText` with `${1:…}`/`$0` bodies but
never `insertTextFormat: Snippet(2)` — verified live (`insertTextFormat:
ABSENT`). Spec-correct clients insert `BROKER SCHEMA ${1:com.example...}`
*literally*. One line fixes it.

**C-5 (low) — message-tree path completion is a stub beyond the first dot.**
`InputRoot.JSON.` → only `Data`; `.XMLNSC.` → a placeholder `Root` ("planned
Phase 3"); `Database.` → a placeholder datasource. Fine as documented, but it
means the most-typed ESQL surface (`OutputRoot.<domain>.<path>`) is where the
completion is least smart. Schema/MRM-model-driven field completion is the
real answer; nothing in the grammar connects .esql text to message models.

**C-6 (low) — line-scoped clause analysis.** Rules see only the current line
(documented in `nextWords.ts`). A clause continued onto the next line falls
back to the general dump — correct-by-degradation, but the roadmap should say
"tree-backed next-word state" is the endgame, since the grammar already knows
the real parse position.

**C-7 (info) — mode drift, one item.** In heuristic mode a mid-edit
`DECLARE x SHARED ` (no type yet) is indexed as a variable **typed `SHARED`**
(the flag word is consumed as the type by `DECLARE_RE`, `src/definitions.ts:45`);
grammar mode indexes nothing there. Visible as 243 vs 244 completion items.
Harmless today, but it shows the two "identical" paths aren't bit-identical.

## 2. Go to definition / references — expected behaviour?

### What works (verified live, both modes)

Within one file: cursor on a variable at a read (`LENGTH(KnownRead`) or write
position → its `DECLARE` (innermost scope wins); parameters incl. multi-line
header lists; routine headers; `CALL` to a **same-file** routine; module names;
schema segments; cursor already on a declaration stays put; built-ins
(`LENGTH`) and message-tree path elements (`Data.Id`) correctly answer
nothing. `workspace/symbol` **does** work cross-file, incl. after the declaring
file is closed (disk index warm): query `Helper` → `helper.esql:8`.

### Findings

**G-1 (critical) — cross-file go-to-definition is not implemented.**
`onDefinition` (`src/server.ts:532-545`) calls `definitionAt(text, …)` over the
*requesting document's text* and maps results to `doc.uri` — structurally
single-file. Verified live: `CALL Helper` (Helper in sibling `helper.esql`) →
`null`; `SET FailureCount` (SHARED in sibling) → `null`; identical in heuristic
mode and with the index warm. The README roadmap itself lists this as planned.
The substrate exists — the index holds routines with uri+range — it's only
wired to `workspace/symbol` and the undeclared check.

**G-2 (high) — references and hover die at the same boundary.** `CALL Helper`
from the use site hovers as nothing (own-file hover and built-in hover are
good: signature block + owning module line). Cross-file references: none.

**G-3 (high) ★ — references on a cross-file `SHARED` name answer `[]` even for
this file's own uses.** `referencesAt` only reports variable uses when a
declaration of that name exists *in the same file*; `FailureCount` used twice
on one line of `main.esql` → zero references, both modes. So find-references
actively misleads for the exact ACE idiom (shared flow variables) rather than
merely being cross-file-blind.

**G-4 (high) — rename can't exist on top of this.** Rename = prepareRename +
references across all files. Neither exists; see §4.

**G-5 (high) ★ — quoted-name declarations regress in grammar mode.**
`DECLARE "script-encoded-hostname" EXTERNAL CHARACTER;` — the tree path in
`analyzeDocument()` indexes only `identifier` children
(`src/parser.ts:749-766`) while the grammar emits `quoted_identifier`
(verified via `tree-sitter parse`). Measured: definition at the quoted name →
resolved in heuristic mode (`helper.esql:4:9`), **`[]` in grammar mode**; the
name also vanishes from the grammar-mode **outline** and from **completion**.
The comment at `src/parser.ts:747` ("Quoted names … are grammar-only") states
the inverse of reality. `test/definitions.test.ts:293` asserts the behaviour
but passes `doc=undefined` — it only ever exercises the heuristic path.

**G-6 (low) ★ — every schema's `main` segment matches routine `Main`.**
`eqName` is case-insensitive and `matchesSchemaName` matches any dotted
segment, so a definition request on `BROKER SCHEMA com.acme.main` jumps to
**both** the schema and the routine `Main()` — in effectively every ESQL
project. Navigation results should not include the routine when the cursor is
inside a `schema_name` node (the tree path knows the parent node type).

## 3. Diagnostics — are the messages good enough to fix the problem?

### What's already close to the ELM ideal

Stable codes (`undeclared-variable`, `missing-end-module`, …) + `source: 'esql'`
+ a `codeDescription` href on **every** diagnostic; each check individually
toggleable. Message inventory from live runs, graded:

| Message | Grade |
|---|---|
| `Module 'X' contains no Main() function. ACE cannot execute it.` | good — what + why |
| `Module 'X' is missing its closing 'END MODULE'.` | good — what + the token to add |
| `Parser 'XMLNS' is deprecated. Use 'XMLNSC' in ACE 12.` | good — fact + the fix |
| `Building OutputRoot.JSON.Data but no copy of Properties detected… Did you forget 'SET OutputRoot.Properties = InputRoot.Properties;'?` | **best in the set** — quotes the exact statement to write |
| `Missing syntax: expected ')' here.` | okay — names the token, but no opening-paren pairing |
| `Syntax error in a SET statement.` | weak — names the construct, never says what's wrong |
| `Syntax error.` | **fails** — zero information, still ships (see E-1) |
| `Variable 'x' is used in SET but never declared with DECLARE.` | okay, but see E-5: only *write* targets are ever checked, so "used" is a lie by omission |

### Findings

**E-1 (high) — the bare `Syntax error.` still ships for ordinary typos.**
`SETN broken = 1;` → `Syntax error.` (grammar mode, live). The message builder
falls through to the bare text whenever the damaged region can't be phrased
(`src/parser.ts:646`). ELM's core move — "I was expecting X here, I found Y,
because Z" — is absent: the found token is never quoted, the expected set is
never named, no did-you-mean against the keyword table (`SETN` is one
transposition from `SET`; the edit distance is *right there*).

**E-2 (high) ★ — one missing `;` at top level silently destroys the whole
file.** Reproduced live: `DECLARE FailureCount SHARED INTEGER` (no trailing
`;`) between `BROKER SCHEMA` and the module → the parse yields a single ERROR
spanning **lines 1–14**, one `Syntax error.` over the whole file, and
`analyzeDocument` returns **empty declaredNames/routines** — so
go-to-definition, completion of declared names, and the undeclared-variable
check all degrade at once, and *correctly declared* variables start looking
undeclared. Two fixes compound here: (a) the message should be
`This DECLARE statement is not terminated — expected ';' before the next
statement` anchored at the statement end, not a file-wide shrug; (b)
declaration mining should keep working inside ERROR regions (the tokens are
all *there* — `kw_DECLARE identifier kw_SHARED datatype` — the recovery just
never reads them).

**E-3 (high) ★ — grammar mode false-flags the legacy `LOGICAL` type, and the
message is wrong.** `DECLARE legacy LOGICAL;` in a clean file → Error
`Missing syntax: expected a data type here.` in grammar mode; heuristic mode →
silent. A reader typing real legacy ESQL is told there is no data type where
there is plainly one. `LOGICAL` is also absent from `ESQL_TYPES`
(`src/data/esqlData.ts`) so completion never offers it either. Either accept it
in the grammar (it's real, deprecated, ACE 12 still compiles it — per the
repo's own rule, adjudicate against the railroad diagram first) or keep the
error but make it `Unknown data type 'LOGICAL'. Was it INTEGER or BOOLEAN you
meant?` — the current text simply doesn't match the user's screen. (Rev-2
measured two diagnostics on a real file; my isolated repro shows one error —
both are false positives; the count depends on damage cascades.)

**E-4 (high) — unknown routine targets are never checked.**
`CALL DoesNotExist('x')` → no diagnostic in either mode, even though the
workspace index can already say "no routine by that name exists anywhere in
this workspace" (and "did you mean `Helper`?" is one Levenshtein away). This
is ESQL's highest-value missing check: `CALL` typos only surface at deploy
time today.

**E-5 (medium) — undeclared *reads* in expressions are not checked, and the
message says "used".** Both check paths walk only bare `SET <target>` write
positions (`doc.setTargets` / `SET_VAR_RE`), so `SET q = UndeclaredRead;`
flags `q` and says nothing about `UndeclaredRead` (verified live, both modes).
The tree path has every identifier it needs (`doc.references`, kind
`variable`). "Reads" are also where the *typo* bugs live.

**E-6 (medium) ★ — the module structure checks silently skip `DATABASEEVENT`
modules.** `diagnostics.ts` `MODULE_RE` accepts `COMPUTE|FILTER|DATABASE`;
`definitions.ts` has the same regex **with** `DATABASEEVENT`. Measured: a
`CREATE DATABASEEVENT MODULE` with neither `Main()` nor `END MODULE` gets
**zero** diagnostics. Two copies of one regex, drifted — exactly the
one-extractor discipline AGENTS.md prescribes elsewhere.

**E-7 (low) — unclosed module double-reports.** `unclosed.esql` →
`Syntax error in a module definition.` **and** `missing-end-module` on the same
line, both Error. The heuristic check should suppress itself when the grammar
already flagged the same region (or better: the grammar message should *become*
the missing-end-module text — it knows more).

**E-8 (medium) — grammar mode loses the good semicolon message.** Missing `;`
on `SET done = TRUE` → heuristic mode: Hint "Possible missing semicolon (';')"
(a good message); grammar mode: `Syntax error in a SET statement.` (worse) —
the design note says the grammar error replaces the hint, but the grammar
error doesn't say what the hint knew. When the ERROR region's *last token* is
a complete statement and the *next* token starts a new statement keyword, the
message should name the semicolon.

**E-9 (high) — no quick fixes.** `codeActionProvider` is absent (verified from
the live `initialize` result). Nothing maps `missing-end-module` → insert
`END MODULE;`, `deprecated-parser` → rewrite `XMLNS`→`XMLNSC`, the Properties
hint → insert the copy line, or `undeclared-variable` → insert a
`DECLARE x <TYPE>;` skeleton at the routine top. The hints' messages already
describe the edit; shipping it as a quickfix is most of the ELM feeling.

**E-10 (low) — no did-you-mean anywhere.** Unknown variable, unknown routine,
unknown datatype (`LOGICAL` aside), typo keyword — none of the paths tries a
near-neighbour from the lists the server already holds (declared names in
scope, workspace routines, keywords, `ESQL_TYPES`).

## 4. Rename — including cross-file and third files

**N-1 (critical) — rename does not exist.** No `renameProvider` in the
advertised capabilities (read off the live handshake); `textDocument/rename`
and `textDocument/prepareRename` both answer
`-32601 Unhandled method` (live, both modes, incl. a cursor on a real SHARED
use). Editors therefore offer nothing — VS Code greys *Rename Symbol*, Neovim
reports the method missing. Nothing about third files even comes up.

**N-2 (architecture, prerequisite) — what cross-file rename needs is not all
built yet.** The pieces and their gaps:

| Piece | State |
|---|---|
| Single-file occurrence finder (`referencesAt`) | exists, good — incl. quoted `"name"` uses; would seed a same-file rename today |
| Cross-file *references* | missing (G-2/G-3) |
| Workspace facts for routines (name → uri+range) | exists in `WorkspaceIndex` |
| Workspace facts for **variables** | `FileFacts.sharedNames` is a `Set<string>` — **names only, no uri/range** (`src/workspaceIndex.ts:41-46`); a SHARED rename in a third file cannot be located without extending it |
| Live-edit safety | open buffers already override the disk snapshot (good pattern to reuse) |
| SHARED-semantics note | ACE SHARED scope is *application*-wide, the index's stand-in is *workspace*-wide (documented approximation in `workspaceIndex.ts`) — a rename is a much more destructive operation than a hover, so the approximation deserves a user-visible note |

A same-file `prepareRename` + `rename` is a day of work on top of
`referencesAt`; cross-file renames (the real question: "does it also rename
mentions in third files?") additionally need G-1/G-3 and the located-facts
change above. **Until then the honest answer to "does rename work" is: no, and
no editor can even attempt it.**

## 5. Test/process findings

**T-1 (fix first, it's failing right now)** — `npm test` fails
`the narrowing filters by the word being typed and is case-insensitive`:
`labelSet('DELETE F')` expects `['FIELD','FROM']`, gets
`['FIELD','FIRSTCHILD','FROM']`. The **code is right**: `DELETE FIRSTCHILD OF
…` is a legal continuation (the rule's own word list, sourced from
`grammar.js`). Fix the expectation, don't chase the narrowing. (Rev-2 reached
the same verdict independently.)

**T-2 (★)** — the quoted-name test (`test/definitions.test.ts:293`) only runs
the heuristic path (`doc=undefined`); every quoted-name expectation needs a
grammar-mode twin (that's how G-5 hid). Per AGENTS.md, `test/symbols.test.ts`
compares both outlines — its fixture just never contains a quoted name.

**T-3** — there is no cross-file *navigation* test at all: `workspaceIndex`
tests cover the index, e2e covers capabilities and same-file features. Any fix
for G-1/G-3/C-2 needs an e2e that opens two files and jumps between them.

**T-4 (process, matches AGENTS.md)** — two more regex-extractor duplications
have crept in since the one-extractor rule was written: E-6's `MODULE_RE`
pair, and the `SHARED`-flag-vs-type quirk behind C-7 is a symptom of the same
pattern divergence. Worth a comment-level pin: the fallback regexes belong in
`definitions.ts` and are imported, never re-typed.

## 6. Suggested work order

| # | Item | Findings | Why first |
|---|---|---|---|
| 1 | Fix the failing test expectation | T-1 | unblocks a green base |
| 2 | `insertTextFormat: Snippet` on snippet items | C-4 | one line, visible in every editor |
| 3 | Complete routine + workspace-SHARED completion from the index | C-1, C-2 | highest-value completion gaps; data already indexed |
| 4 | Cross-file definition/references/hover via the index; fix G-3's same-file `[]`; extend `FileFacts` with located SHARED vars | G-1, G-2, G-3, N-2 | the navigation promise the README makes; prerequisite for everything rename |
| 5 | Quoted-name parity in grammar mode (`quoted_identifier` in tree extraction) + grammar-mode tests | G-5, T-2 | silent mode-split, wrong comment misleads the next reader |
| 6 | Error-message pass: never bare `Syntax error.` (quote the found token, name the expected set); semicolon-aware message (E-8); LOGICAL adjudication (E-3); message-wording fixes (E-5) | E-1, E-2, E-3, E-5, E-8 | pure analyzer work, biggest "understand and fix" payoff |
| 7 | New checks: unknown `CALL` target (+ did-you-mean), undeclared reads | E-4, E-5 | real bug classes, index already makes them cheap |
| 8 | Same-file rename, then cross-file rename | N-1, N-2 | lands only after 4; the user-visible answer to question 4 |
| 9 | Quickfixes for the codes that name their own fix | E-9 | turns good messages into one-keystroke fixes |
| 10 | `filterText` instead of server-side pruning; DATABASEEVENT check; schema/`Main` disambiguation; module-message dedupe | C-3, E-6, G-6, E-7 | hygiene, each is small |

---

### Appendix — how to re-run the evidence

```
cd /tmp/opencode/esql-review-3 && node probe.js                      # grammar mode report
ESQL_LSP_NO_GRAMMAR=1 node probe.js                                  # heuristic report
```

Fixtures: `ws/helper.esql` (SHARED + quoted EXTERNAL declare, routine
`Helper`), `ws/main.esql` (clean consumer: cross-file `CALL` + SHARED use),
`ws/broken.esql` (typo `SETN`, unclosed `CAST`, missing `;`, `LOGICAL`,
`XMLNS`), `ws/nomain.esql`, `ws/unclosed.esql`, `ws/typo.esql` (unknown CALL,
undeclared read), `ws/scratch.esql` (clause-boundary cursor lines). Caveat
learned while building it: ESQL semicolons matter enormously — a missing `;`
in a fixture doesn't just fail that line, it eats the file (see E-2).
