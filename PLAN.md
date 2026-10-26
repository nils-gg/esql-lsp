# Implementation plan — closing CODE_REVIEW.md (rev 3)

**Scope:** every finding in `CODE_REVIEW.md` rev 3 — C-1…C-7, G-1…G-6, E-1…E-10,
N-1, N-2, T-1…T-4. (Note: the review defines **G-1…G-6**; there is no G-7.
G-4 — "rename can't exist on top of single-file references" — is not a separate
work item; it closes the moment the rename work (N-1) lands on the fixed
navigation, so it is tracked inside task 5.2.)

Findings merge where they share one file/one mechanism; the mapping table in
§6 guarantees nothing is dropped. Sizes: **S** ≤ 1 h · **M** = 1–4 h ·
**L** = 0.5–2 d.

## 0. Ground rules (from AGENTS.md — apply to every task)

- After editing `grammar.js`: `npx tree-sitter generate` **and** `npm ci` at the
  repo root (the `file:`-dep copy trap), corpus test in `test/corpus/`,
  `VERIFICATION.md` note for any adjudicated construct.
- Every new diagnostic check: unit test + e2e assertion over a real stdio
  session + a settings-toggle case (`test/e2e.test.ts`), and it must work in
  heuristic mode too (fallback tests must not skip via
  `skipWithoutGrammar()`).
- e2e fixtures are line-number-coupled — re-verify request positions when
  editing fixture text.
- `npm test` **and** `ESQL_LSP_NO_GRAMMAR=1 npm test` **and**
  `npm run grammar:test` green per task; `scripts/record_demo.sh` in both modes
  whenever completion UX changes; `npm run verify:package` before tagging.
- Commits: one-line subject + body naming what was verified; identity
  `nils <nige@users.noreply.github.com>`; reference findings by review id
  (e.g. "C-1, C-2: …").

---

## Phase 0 — green base, quick wins

### 1. T-1 — fix the failing expectation, commit the WIP  `[S]` → closes T-1

The uncommitted `nextWords.ts` work is the foundation of tasks 6–7; it cannot
stay red and unstaged.

- [x] `test/completion.test.ts`: expect `['FIELD','FIRSTCHILD','FROM']` for
      `labelSet('DELETE F')` — the code is right (review §T-1).
- [x] `npm test` → 141/0; `ESQL_LSP_NO_GRAMMAR=1 npm test` → same.
- [x] Commit: `test/completion.test.ts` fix + `src/data/nextWords.ts` +
      `src/completion.ts` as one coherent feature commit (the clause-aware
      next-word completion), body naming the suite counts.

### 2. C-4 — snippets as real LSP snippets  `[S]` → closes C-4

- [x] `snippetItems()` in `src/completion.ts`: set
      `insertTextFormat = InsertTextFormat.Snippet(2)`.
- [x] Guard: keep it only when the client declared
      `completionItem.snippetSupport`; otherwise strip `${1:x}`/`$0` to plain
      text (fallback clients would insert placeholders literally). Requires
      capturing the capability in `onInitialize` (one boolean next to
      `clientWantsHierarchicalSymbols`) and passing it into
      `buildCompletionItems`.
- [x] Unit: item carries the flag with snippetSupport; carries PlainText +
      de-placeholdered text without it. e2e: the existing capability session
      asserts the flag.

### 3. E-6 + T-4 + C-7 — one extractor for the fallback patterns  `[S/M]` → closes E-6, T-4, C-7

- [x] Delete `MODULE_RE` from `src/diagnostics.ts`; import the
      `CREATE … MODULE` matcher (or a `moduleHeaderMatch(line)` helper) from
      `src/definitions.ts` — single source, `DATABASEEVENT` included, so
      `missing-end-module` / `module-no-main` fire on DATABASEEVENT modules.
- [x] Add the AGENTS-style pin comment: fallback regexes live in
      `definitions.ts` and are imported, never re-typed (T-4).
- [x] C-7: fix `DECLARE_RE` in `src/definitions.ts` — a flag word may not be
      consumed as the datatype when no real type follows
      (`(?!(?:SHARED|EXTERNAL|CONSTANT)\b)` before the type group), so
      mid-edit `DECLARE x SHARED ` declares nothing in heuristic mode, matching
      the tree. Add the mode-parity completion-count test (243 == 243).
- [x] Unit: DATABASEEVENT module missing Main/END MODULE now flagged;
      `DECLARE x SHARED;` / `DECLARE x SHARED ` declare nothing;
      `DECLARE x SHARED INTEGER;` still declares.

  *Found while testing:* the parity claim holds in the buffer-being-typed
  state (open module: both paths declare nothing for a flag-only line), but
  inside an already-CLOSED module the tree's ERROR-region recovery indexes a
  typeless `DECLARE x SHARED;` as `x` with empty detail. Deliberately not
  asserted; task 10 adjudicates what damaged-region recovery should trust.

---

## Phase 1 — the workspace symbol foundation (unlocks navigation, completion, rename)

### 4. N-2 — located workspace facts + lookup API  `[M]` → closes N-2 (enables 5, 6, 10, 13)

Today `FileFacts.sharedNames` is `Set<string>` — names without a home. Everything
cross-file (definition, references, rename, completion detail) needs *located*
facts. Extend, don't rebuild:

- [x] `src/workspaceIndex.ts`: add to `FileFacts` a
      `sharedVars: Array<{ name, uri, range, detail }>` (keep `sharedNames`
      derived or replace its readers — `sharedNamesFromDisk` has exactly one
      caller in `server.ts`). `extractFileFacts` already runs
      `declarationsFromSource`, which carries ranges and `shared: true`.
- [x] Index query API: `lookupRoutine(name)`, `lookupSharedVar(name)` over
      disk facts **plus live open documents** (same overlay pattern as
      `sharedNamesFromWorkspace()` in `server.ts:164` — hoist that overlay into
      a reusable `workspaceFacts()` helper so every consumer gets one merge).
- [x] Index routines by uppercase name (Map) for O(1) lookup; keep
      `symbolsFromDisk` for `workspace/symbol` as-is.
- [x] Unit: located SHARED facts extracted (incl. quoted SHARED names — must
      agree with task 5's outcome); lookup merges live buffer edits over the
      disk snapshot.

### 5. G-5 + T-2 — quoted names in the tree path  `[M]` → closes G-5, T-2

Independent of tasks 4–7; do it while the parser code is fresh. The grammar
emits `quoted_identifier`; `analyzeDocument()` only indexes `identifier`
children.

- [x] `src/parser.ts` declare-statement walk: also index
      `child.type === 'quoted_identifier'` (name = text without the quotes,
      range = inner text, matching `wordAtPosition`'s quoted handling so
      cursor↔declaration ranges agree).
- [x] Fix the wrong comment at `src/parser.ts:747` — it states the inverse of
      reality.
- [x] Check the same walk for other `quoted_identifier` sites (routine
      `EXTERNAL NAME`, `NAME 'alias'` clauses) — index or document.
- [x] T-2: give every quoted-name expectation in `test/definitions.test.ts` a
      grammar-mode twin (pass the real `DocAnalysis`, not `undefined`); add a
      quoted name to the fixture `test/symbols.test.ts` compares across modes —
      it must appear in the grammar outline (currently vanishes: measured).

  *Also landed:* both paths now treat `""` inside a quoted name as one
  escaped quote (`unquoteESQLName` in scanner.ts is the single convention;
  `QUOTED_DECLARE_RE` widened to `(?:[^"]|"")+`), keeping the modes bit-equal
  on escaped names too.

### 6. G-1 + G-2 + G-3 + G-4(partial) + T-3 — cross-file navigation  `[L]` → closes G-1, G-2, G-3, T-3 (needs 4)

One coherent change: the feature modules gain a *workspace lookup* parameter;
`server.ts` resolves what the document itself cannot answer.

- [x] Definition: in `onDefinition` (`src/server.ts:532`), when local
      `definitionAt` finds nothing for the word and a workspace root exists:
      `lookupRoutine` / `lookupSharedVar` → `Location` in the declaring file.
      Keep same-file resolution winning (local shadow). Applies to both parse
      modes (the index is heuristic-extracted anyway → mode-identical).
- [x] Hover: same fallback → signature block synthesized from facts
      (`FUNCTION RETURNS X`, container module, uri) with a `defined in
      helper.esql` line.
- [x] References (G-3 first, then cross-file): `referencesAt` currently reports
      zero for a name declared in a sibling — fix the in-file half: when the
      word matches a workspace SHARED name (or has a located fact), report the
      current file's occurrences. Cross-file half: `onReferences` additionally
      consults located facts **and** scans other files' text (disk snapshot +
      open buffers) with the existing whole-word occurrence finder — SHARED
      variables and user routines are the two worth scanning (documented
      workspace≈application approximation, see review N-2's last row).
      A ROUTINE name answered by the current file stays file-local (the local
      shadow — `Main` in ten files means ten routines).
- [x] Mark cross-file results so hover/e2e can assert the path taken.
      (Hover carries `*workspace — defined in …*`; definitions/references are
      assertable by the returned uri. Rename, task 16, gets the same hook.)
- [x] T-3: new e2e case — open a two-file fixture workspace, `definition` from
      `CALL` jumps to the sibling, `references` on the SHARED name returns
      ranges in both files, hover on the call target shows the signature;
      must pass with and without the grammar.
- [x] README feature section: cross-file go-to-definition is no longer
      "planned" — update the roadmap lines the review cited.

### 7. G-6 — schema segment vs `Main()` routine  `[S]` → closes G-6

- [x] In the tree path of `definitionAt`, when the cursor's word sits inside a
      `schema_name` node, drop routine matches; heuristic path: same rule when
      the line matches `BROKER SCHEMA …` within the cursor span.
- [x] Unit: `BROKER SCHEMA com.acme.main` with a `Main()` routine in view →
      exactly one location (the schema), and clicking `Main` still finds the
      routine.

  *Found while testing:* clicking the ROUTINE's own name also long included
  the schema (segment match, pre-existing, both modes). Left as is — G-6's
  claim is the schema-segment click resolving to exactly one location, and
  the routine click still lists the routine.

---

## Phase 2 — completion upgrade

### 8. C-1 + C-2 — routines and workspace SHARED names in the list  `[M]` → closes C-1, C-2 (needs 4)

- [x] Feed routines to `buildCompletionItems`: own file's
      `analysis.routines` (both modes: `routinesFromSource` is already shared)
      as `Function`-kind items with signature detail; workspace routines via
      task-4 lookup, detail `in <file> · <signature>`.
- [x] SHARED variables from task 4 lookup as `Variable` items, detail
      `SHARED, declared in <file>`.
- [x] Keep them *out* of clause-narrowed lists (the `=` `TYPE` `VALUE` lists
      must stay closed); additive/general only. Dedupe by label still applies;
      same-file wins over same-named workspace fact.
- [x] Position-sensitivity: routine items appear in general lists everywhere
      (they are valid in expressions too), not only after `CALL`.
- [x] Unit + e2e (both modes): `CALL Hel` → `Helper`; general list contains
      `Main` and `FailureCount`; narrowed `SET x ` list unchanged (still 5).

  *Landed as:* the 7th `buildCompletionItems` param `facts?: CompletionFacts`
  (own routines default to `routinesFromSource(source)`; the server excludes
  the current file from the ws lists and pre-renders signatures). Closedness
  is asserted against the non-additive `DELETE ` rule (snippets absent →
  only clause words); the `SET x ` count stays asserted by the pre-existing
  test (untouched, and green). New per-keystroke path got a text-identity
  cache (`liveFactsCache`) — completion is not debounced, so
  `workspaceFacts()` must not re-scan open buffers; cleared on didClose.
  The dedupe stays exact-label (the graveyard's case-folded merge stays
  dead); own declared AND routine names join the `preferred` set.

### 9. C-3 — let the client do fuzzy matching  `[S/M]` → closes C-3 (touches 8's output)

- [x] Drop the `startsWith` pruning in `filterByPrefix` for the **general**
      list; keep the clause-table narrowing (that is context, not prefix).
- [x] Set `filterText = label` on items whose label can fool matchers (quoted
      names → the bare name; snippets keep the label as typed).
- [x] `sortText`: put clause-rule items and in-scope declared names first so
      label-alphabetical clients still rank sensibly.
- [x] Re-run `scripts/record_demo.sh` in **both** modes — the README demo
      drives omnifunc with explicit C-n/C-y and asserts pane content; verify
      the asserted selections still land.
- [x] Perf guard: list-size assertion in a test (general list bounded, ≤ ~300
      items as today).

  *Landed as:* clause lists keep their own prefix pruning (`DELETE F` still
  means F — the T-1 expectations stand untouched); the additive merge prunes
  only its clause head. `filterText` goes on the user-name items and every
  snippet (quoted names are already bare labels since task 5, so nothing to
  translate). `sortText` = `0:`-clause / `1:`user-names + label — digits
  float both groups above the unranked built-ins for string-sorting clients;
  nvim ignores it and uses list order, which did not change. Measured general
  list: 242 items. Both demo tours green with and without the addon.

---

## Phase 3 — diagnostic messages (the ELM pass)

### 10. E-1 + E-8 + E-10 — the message builder never goes silent  `[L]` → closes E-1, E-8, E-10 (shared util also serves 12–14)

- [x] New shared util `src/suggest.ts`: bounded Levenshtein +
      `didYouMean(word, candidates, maxDist)`; candidate lists built from data
      the server already has (keywords, `ESQL_TYPES`, workspace routines,
      declared names in scope). Unit tests incl. case-insensitivity and the
      empty-list contract ("no suggestions" ≠ guessing).
- [x] `describeDamagedRegion()` in `src/parser.ts`: the bare `Syntax error.`
      fallthrough (line ~646) must become — in priority order —
      1. **Semicolon case (E-8)**: last token of the region completes a
         statement (`;`-terminated grammar shape) and the following token
         starts a new statement keyword →
         `Statement is not terminated — expected ';' here.` (this recovers
         what heuristic mode's hint already said, in grammar mode);
      2. **Found-token case**: quote the offending token and name what the
         region was attached to:
         `Unexpected 'SETN' in a SET statement. Did you mean 'SET'?`
         (did-you-mean only against keywords within edit distance);
      3. **Last resort** (still no bare text): `Syntax error in <phrase>:
         unexpected '<token>' here.` — the region text is always quoted.
- [x] Corpus of message assertions: extend `test/parser.test.ts` with
      `messageFor(snippet)` expectations for the review's live cases (SETN,
      unclosed CAST, missing `;` variants) — messages become tested surface,
      not ad-hoc strings.
- [x] Keep `Missing syntax: expected …` paths; add the opening-paren position
      when the grammar exposes it (`expected ')' — this '(' on line 8 is
      unclosed`).

  *Landed as:* `editDistance(a,b,maxDist)` aborts the DP row past the cap and
  `didYouMean` excludes distance 0 (an exact match is not a suggestion) and
  sorts closest-first so candidate lists can encode preference. The parser
  suggests against `ESQL_KEYWORDS` only (the routines/declared lists join at
  tasks 13–14); only NON-keyword words can be typos, and the distance-2
  allowance is earned at 5 letters (`bad`→`BY` at 2 is why). Semicolon case:
  region's first MASKED word (a word inside a comment is not a token) is a
  statement opener AND the nearest `*_statement` ancestor — with containers
  stopping the climb — ends its masked text in `;` (the swallowed second
  statement's own terminator). Anchor: end of the first statement through the
  gap before the region. Named `Syntax error in <phrase>.` messages stay
  EXACTLY as written unless a did-you-mean suffix applies (the I-12 corpus
  proves IF/SET/module-definition keep their bare named forms); the only
  named message E-8 deliberately replaced is `Syntax error in a DECLARE
  statement.` for the `DECLARE x INT 0` seam — adjudicated as saying less
  than both the hint and the new message. Found-token/last-resort: quoted
  word-or-punctuation-run `Unexpected 'tok' here.`; a region of pure comment
  damage (no token at all) is the single honest `Syntax error.` residue.
  Opening-paren clause applies to grammar-INSERTED `)`/`]` only (the review's
  exact broken.esql wording reproduced); note the review's unclosed-CAST
  line-with-`+` DOES insert `)` while the bare `CAST('1' AS INTEGER;` form
  passes the permissive grammar silently — grammar strictness, not the
  message builder, and VERIFICATION territory. Settings: no new check, same
  `syntax-error` code — existing gating (`gated` unit + I-21 code-over-wire
  e2e) covers the toggles unchanged.

### 11. E-2 + E-7 — damage-tolerant analysis, honest cascade message  `[L]` → closes E-2, E-7

- [x] Message (E-2a): when a top-level statement's ERROR region starts at a
      statement keyword and extends ≥2 statements, the message names the
      unterminated statement and anchors at its end:
      `This DECLARE statement is not terminated — expected ';' before 'CREATE'.`
      (the follow-token scan from task 10 already exists by then).
- [x] Mining (E-2b): declaration/routine extraction must keep working inside
      ERROR regions. Recommended route (reuses one extractor, no new parser):
      run the heuristic extractors (`declarationsFromSource`,
      `routinesFromSource`) over the *region text* and merge results with the
      tree's — tree ranges win where they agree; damaged-only names come from
      the regex pass. Both modes then behave identically under damage.
- [x] E-7: when the grammar emitted a syntax error covering a module header,
      `checkModuleStructure` suppresses its duplicate `missing-end-module`
      **iff** the grammar message already says module; better per review:
      promote the grammar message to the good `missing-end-module` text and
      suppress the grammar's generic phrasing for that shape instead. One
      diagnostic per root cause; assert via fixture `unclosed.esql`.
- [x] Regression probe: the review's E-2 fixture must keep definitions +
      completion + undeclared-check alive under the single file-wide ERROR.

  *Landed as:* E-2a reuses task 10's seam reading — the cascade variant
  fires when the region's MASKED text holds another statement opener past
  its first word (`OPENER_SCAN_RE`), naming the ancestor statement kind and
  the word that ran over it; one swallowed statement keeps the plain E-8
  wording (corpus pins both phrasings distinct). E-2b: `analyzeDocument`
  collects outermost ERROR regions during the walk and re-runs
  `declarationsFromSource`/`routinesFromSource`/`bareTargetsFromSource`
  (the SET-target rule moved to `definitions.ts` — one extractor, E-6
  discipline) over each region's text, padded to whole lines (extractors
  are line-anchored; padding from column 0 keeps mined columns true file
  columns), shifted back and merged with tree entries added FIRST (position
  dedupe `NAME@line:char`). Mined declarations get scope = declaration →
  EOF: the structure scopes derive from is exactly what the damage ate, and
  a fabricated narrow boundary is E-2 relabelled. E-7: `SyntaxIssue.kind
  = 'module-definition'` (derived from the phrase, so every naming path
  tags itself) + `analyze()` drops that kind when `missing-end-module`
  fires on the same line — the structure text wins (it names the module);
  a damaged header of a CLOSED module keeps its message (test pins
  non-suppression; e2e's `%%%`-fixture syntax-error pins the same over
  stdio). Regression probe: both modes warn exactly `neverSeen` on the
  review fixture (diagnostics unit), e2e DamagedI6 reworked to wait on
  the mined undeclared inside the damage + assert the single END MODULE
  report; `record_demo.sh` MODE_PAT unified — the pane text is now
  mode-independent. The old grammar-mode I-6 unit asserting the duplicate
  syntax-error went red exactly as the design intends and was retargeted
  to the single-report contract.

### 12. E-3 — `LOGICAL` adjudication  `[M]` → closes E-3

Per repo rule the ACE 12.0.x **railroad diagram adjudicates** — decide first,
implement second, and record the decision either way in `VERIFICATION.md`
("Unadjudicated construct gaps" discipline).

- [x] Check the diagram / IBM docs for `LOGICAL` in DECLARE (webfetch only —
      ibm.com 403s shell curl, per repo graveyard).
- [x] **If legal** (expected): add `LOGICAL` to the grammar `datatype` rule →
      `npx tree-sitter generate` → `npm ci` → corpus test → `grammar:test`;
      add it to `ESQL_TYPES` (`src/data/esqlData.ts`) marked deprecated
      ("legacy synonym — prefer INTEGER/BOOLEAN") so completion offers it;
      optionally a *hint*-severity `deprecated-type` note (new code, setting,
      unit + e2e + toggle case per ground rules).
- [ ] **If rejected**: keep the error, fix the lie in the message:
      `Unknown data type 'LOGICAL' — ESQL knows CHARACTER, INTEGER, … ;
      did you mean 'BOOLEAN'?` (uses task 10's util), and keep `LOGICAL` out
      of `ESQL_TYPES`.
- [x] Either way: both-modes test that a clean file with `LOGICAL` yields
      grammar mode and heuristic mode the *same or strictly softer* result —
      the "tree path worse than fallback" split is the actual defect.

  *Landed as:* the diagram route ran but the diagram does NOT list LOGICAL:
  the 12.0.x DECLARE page (ak04980_) and the ESQL non-reserved keywords page
  (both fetched verbatim 2026-10-26) omit it — it is pre-ACE vocabulary. The
  permissive-superset rule still accepts it (real legacy ESQL ACE 12 compiles;
  the review measured that), so this is the accept branch + the optional hint,
  recorded in VERIFICATION.md. `kw_LOGICAL` joins `datatype` with zero new LR
  conflicts; corpus pins bare/`FALSE`-valued/`SHARED`-before-datatype forms.
  Rev-2's `DECLARE TraceEnabled LOGICAL SHARED TRUE;` repro was confounded:
  SHARED-after-datatype is rejected for EVERY datatype (INTEGER included) and
  the diagram puts SHARED before it — not a LOGICAL issue, left strict.
  Analyzer side: flat `deprecated-type` HINT (setting `checkDeprecatedTypes`,
  README row + settings JSON), regex pins the DATATYPE SLOT (name list +
  optional SHARED/EXTERNAL/CONSTANT first) so `DECLARE logical INTEGER;`
  cannot false-positive; `ESQL_TYPES` carries LOGICAL marked deprecated.
  Both-modes probe asserts the full diagnostic list (codes+messages+ranges)
  is IDENTICAL between modes and grammar mode reports zero syntax issues;
  e2e ships the hint over stdio + its own toggle-off case (no skip guard —
  the flat check's mode-independence is the E-3 point; severity 4 = LSP Hint).

---

## Phase 4 — new checks (cheap once the index + suggest util exist)

### 13. E-4 — unknown `CALL` target  `[M]` → closes E-4

- [x] New check in `src/diagnostics.ts`: bare `CALL <name>` / expression
      function references whose name is not declared in file, not in the
      workspace index (task-4 lookup incl. open buffers), not a built-in —
      message: `Routine 'DoesNotExist' is not defined in this file or
      workspace. Did you mean 'Helper'?` (task-10 util).
- [x] New code `unknown-routine`; settings flag `checkUnknownRoutines`;
      README diagnostics table row; **only active with a workspace root**
      (no root → the workspace says nothing, stay silent, like I-13's rule).
- [x] False-positive guards (name them in code comments): dynamic/external
      routines (`EXTERNAL NAME`), index overflow files (skipped count > 0 →
      suppress or soften), built-in list from `esqlData`.
- [x] Ground-rule test trio incl. settings toggle + both modes + a no-root
      degradation case.

  *Landed as:* flat check; grammar mode reads `doc.references` (kind
  `routine`, CALL refs carry the qualified text), heuristic mode scans
  masked lines (`CALL name` + `name(`). Guards, all in the function
  comment: qualified targets skipped (name or qualified contains `.` —
  expression-level dotted calls don't even parse); `EXTERNAL NAME`
  routines carry a local CREATE header so the file set covers them
  (probed); index `skipped > 0` → server sends no set → silent (proved
  e2e with a 300 KB sibling past `MAX_FILE_BYTES`); allow list =
  `ESQL_FUNCTIONS` ∪ `ESQL_KEYWORDS` ∪ datatype-slot words (`VARCHAR(10)`
  in CAST, `VARYING(20)` — the flat scan's main FP risk, verified silent).
  ASBITSTREAM was missing from `ESQL_FUNCTIONS` while the grammar names
  it a clause function — added (completion offers it too now). Suggestions
  prefer routine candidates over built-ins (didYouMean keeps order on
  ties). No-root degradation = unit test; toggle = unit + e2e; both-modes
  equality unit asserts the fixture is grammatically clean first, then
  position-for-position agreement.

### 14. E-5 — undeclared reads  `[L]` → closes E-5

- [x] Grammar mode: walk `doc.references` (kind `variable`) — a read whose
      name is nowhere in scope, not reserved, not workspace-SHARED →
      `Variable 'UndeclaredRead' is read here but never declared.` with
      did-you-mean against names in scope.
- [x] Heuristic mode (required — checks work in both): conservative
      occurrence-based pass — whole-word bare identifiers on masked code
      lines, excluding dotted-path parts, statement keywords, labels,
      routine names, and anything in `RESERVED_SET_TARGETS`/declared/workspace
      sets; suppress the whole check in files the scanner flags as damaged.
- [x] Reword the write-target message to distinguish the two roles ("assigned
      here" vs "read here") — today "used in SET" is a lie by omission.
- [x] Own settings flag `checkUndeclaredReads` (default on), code
      `undeclared-read`, ground-rule test trio, and a false-positive sweep on
      the real 103-file corpus before defaulting on (the I-13 experience says
      measure, then decide).

  *Landed as:* file-FLAT declaredness in both modes deliberately (a name
  declared anywhere satisfies a read — a scope miss is a different true
  problem; fabricating scope errors is the E-2 failure mode reborn, and
  file-flat is the notion both paths can agree on). Tree path:
  `doc.references` kind `variable` minus positions that are SET write
  targets (check 2 owns those; `SET x = x` dedup), minus refs inside new
  `doc.selectExpressions` (columns/tables/aliases), minus official-keyword
  words and refs inside `doc.errorRegions` or before `(` (recovery artifacts
  and call shapes — `SET a = Fn(` mid-typing must never read as "variable
  'Fn' never declared"). Flat path: depth-0 tokens on masked lines only,
  CREATE/DECLARE/SELECT-ish lines skipped, character-adjacency rule on the
  RAW line (masking preserves offsets but blanks quotes — `X'FF00'` glue is
  only visible unmasked); any whole-file paren/brace imbalance silences the
  check. Contract tests: READS_MODULE asserted byte-identical between modes
  after proving the fixture grammatically clean, and the corpus-wide subset
  test (all 86 grammar cases + ws fixtures, ~200 honest findings) pins
  flat-findings ⊆ tree-findings — flat may miss, never contradict.
  Side fixes the FP sweep forced: `ESQL_KEYWORDS` was 122 curated words
  missing INSERT/FULL/ESCAPE/NONE/DEFAULT/INF/NAN/SYMMETRIC/… — backfilled
  to 194 from both official keyword pages (fetched verbatim 2026-10-26; it
  is the E-4/E-5 allow list AND completion; C-3 bound 300→400); the tree
  silently ignored the namespace-alias DECLARE (flat indexed it — a mode
  split waiting), now collected into `doc.namespaceAliases` keeping the
  G-5 outline stance; FOR-loop row variables are declared names (shared
  `forBoundNames` for both paths); the `INTERVAL '1' DAYS` plural-qualifier
  gap became a VERIFICATION.md row (recovery left `DAYS` as a fake
  identifier). The 103-file corpus is gone from disk — the sweep ran over
  the grammar corpus + rev-3 ws fixtures instead (zero false positives,
  zero mode contradictions). Write message reworded to "is assigned here"
  (README/demo patterns followed).

---

## Phase 5 — rename (the answer to "does it work in third files?")

### 15. N-1a — `prepareRename` + same-file rename  `[M]` → part of N-1

- [x] Capability: `renameProvider: { prepareProvider: true }`.
- [x] `prepareRename`: reuse `wordAtPosition` (quoted names already handled —
      placeholder = bare name); reject on built-ins, path elements, comments,
      past-EOF (follow the `viewPosition` conventions).
- [x] `rename` for file-local symbols (routine-body/module-scope variables,
      parameters): reuse `referencesAt` incl. quoted uses; return one
      `WorkspaceEdit` over the requesting file only.
- [x] **Refuse cleanly, don't half-do:** SHARED variables and routines while a
      workspace root exists and cross-file isn't wired yet →
      `ResponseError` naming why ("declared SHARED — other files may call it;
      cross-file rename arrives with the workspace pass"). This safety rule
      exists precisely because the same-file rename of a SHARED name *breaks*
      siblings.
- [x] Tests: e2e rename of a local var (both modes), quoted-name rename, the
      refusal case.

  *Landed as:* `referencesAt(includeDeclaration = true)` IS the rename range
  engine — one shared engine means the edit list equals the find-references
  list by construction, quoted names included; the server side is a symbol
  resolver + validator + refusal, kept in `server.ts` because that is where
  protocol knowledge lives. Resolver matches declarations/routines over BOTH
  extraction sources (rename must offer what references offers); excluded by
  absence: modules, schemas, namespace aliases (renaming `tns` without
  offering its uri is half a rename), undeclared names, built-ins, path
  parts. Refusals answer from `prepareRename` TOO, so a good client blocks at
  F2 instead of after the user types: SHARED + any routine while a root
  exists (without one nothing else can reference them, so the file-local
  rename is complete — allowed), and `Main()` always (ACE calls it by name;
  `module-no-main` would then warn — the name is the platform's, not the
  user's). New-name validation: identifier-shaped unless the DECLARATION is
  quoted (adjacent `"`s in the raw text license odd shapes; the edits rewrite
  inside the quotes), the 12 official RESERVED words refused (non-reserved
  ones are only discouraged and several — NAME, VALUE, TYPE — are common
  names completion offers, so refusing them would refuse real code), and
  collisions case-insensitively (a self-case-fix `total`→`Total` is not a
  collision — it rewrites every occurrence, a free casing fix).
  FORCED FIX, bigger than rename: the tree path never indexed a QUOTED use
  (`field_reference` accepted one `identifier` child only), so a rename from
  the DECLARE would have rewritten the declaration and left every
  `SET "my var" = …` behind — and the gap was invisible to every existing
  feature because `referencesAt` from a quoted USE adds the cursor's own
  range, which covered for the missing reference. Now both paths return the
  same three ranges from the declaration (`test/definitions.test.ts` pins
  the tree mining too). Parameters are renameable (DeclKind `parameter`,
  positional calls mean a parameter rename can never break a caller); the
  pattern path's alias index (`detail === 'NAMESPACE'`) is excluded so the
  modes agree on `DECLARE tns NAMESPACE '…'`. Tests: one 25-field rename
  conversation recorded from a real session, asserted literally in BOTH
  modes (grammar-mode run skip-guarded, fallback run unguarded), plus the
  rooted refusal session with a sibling that really uses the SHARED name and
  calls the routine.

### 16. N-1b + G-4 — workspace-wide rename, third files included  `[L]` → closes N-1, G-4 (needs 4, 6, 15)

- [ ] Generalize task 6's cross-file reference engine into
      `workspaceReferences(name, kind)`: located facts (task-4 SHARED decls +
      routines) + per-file text scan (disk snapshot via index + live open
      documents; open text always wins) → `Location[]` across files.
- [ ] `rename` now unions: current file (ranges from `referencesAt`), other
      open documents (ranges from the live text), disk files (re-read text,
      re-scan with the same occurrence finder at request time — stale-snapshot
      guard: if a disk file changed on disk since indexing, re-scan fresh).
- [ ] SHARED semantics honesty: the change includes an annotation
      (`WorkspaceEdit.changeAnnotation` or a `message` in the UI flow) that
      ACE SHARED scope is *application*-wide and this renamed everything the
      *workspace* could see (the documented approximation, surfaced where the
      user can act on it).
- [ ] Bounds: respect the index caps (500 files / size limits); refuse with a
      clear error when the workspace was skipped/truncated rather than a
      silent partial rename.
- [ ] e2e: three-file fixture — rename a SHARED variable in file A, assert
      edits land in A (decl), B (uses), C (uses); routine rename rewrites a
      cross-file `CALL`; quoted-name SHARED rename; both modes.
- [ ] README: rename documented as a feature; roadmap line flipped from
      "planned".

---

## Phase 6 — quick fixes (the last ELM ingredient)

### 17. E-9 — `codeActionProvider` + fix set  `[L]` → closes E-9 (needs phases 3–4 stable)

- [ ] Advertise `codeActionProvider` (quickfix kind only); match published
      diagnostics by `code` — every code names its fix.
- [ ] Fixes, in order of message-implies-edit clarity:
      1. `deprecated-parser` → rewrite `XMLNS` → `XMLNSC` (range is exact);
      2. `missing-end-module` → insert `END MODULE;` at EOF (indent-matched);
      3. `no-propagation` → insert `RETURN TRUE;` in Main's `END;`;
      4. `output-root-properties` → insert the `SET OutputRoot.Properties =
         InputRoot.Properties;` line at the routine head;
      5. `undeclared-variable` / `undeclared-read` → insert
         `DECLARE <name> CHARACTER;` skeleton (type = CAST-hinted if inferable,
         else ask via a second oneOf-style action variant, not a guess);
      6. semicolon-family (from tasks 10/11 when the message named `;`) →
         insert `;` at the anchor;
      7. `did-you-mean` variants → replace-with-suggestion, one action per
         candidate, max 3.
- [ ] Each fix is a `WorkspaceEdit`; unit-test each transform, e2e asserts the
      action list for a published diagnostic and applying one over stdio.
- [ ] Settings: fixes obey the owning check's toggle.

---

## Phase 7 — lower-priority completion work

### 18. C-5 — better static message-tree completion (model work stays deferred)  `[M]` → closes C-5 at its agreed scope

- [ ] Interim, static, honest: after `.JSON.` offer `Data` **and** `Properties`
      (with the copy-hint doc); `InputLocalEnvironment.` etc. get the known LE
      field list (already exist — extend `ESQL_LOCAL_ENVIRONMENT_FIELDS`
      against the ACE docs page, webfetch, attribution note);
      `Database.` placeholder gains a "configure the datasource in the
      Integration Server" doc line (it has one — extend with `SET` example).
- [ ] Keep the placeholder-only behaviour for XMLNSC paths, but say so *in the
      item* (it already does) and add the explicit deferral note to README:
      model-driven (XSD/MRM/BDF) field completion is its own project phase —
      it needs message-model parsing, which is outside this repo's current
      scope. Do **not** fake it.

### 19. C-6 — tree-backed clause state (grammar mode only)  `[L]` → closes C-6

- [ ] In grammar mode, resolve the cursor's enclosing node from the parse tree
      and derive the legal next words from the grammar (`node-types.json`
      `next` sibling edges) instead of the current-line table; multi-line
      clauses then narrow correctly.
- [ ] Heuristic mode (and damaged regions, incl. mid-edit files the parser
      hasn't recovered): keep the `NEXT_WORD_RULES` table — it stays the
      fallback, per the project's degradation promise.
- [ ] Parity tests: every clause the table covers, written across two lines,
      narrows the same in tree mode as the table does on one line; demo
      re-run both modes (this changes what users see while typing).

---

## Ordering & rationale (summary)

| # | Task | Closes | Depends on | Size |
|---|------|--------|------------|------|
| 1 | green base + commit WIP | T-1 | — | S |
| 2 | snippet format | C-4 | — | S |
| 3 | one extractor | E-6, T-4, C-7 | — | S/M |
| 4 | located workspace facts | N-2 | — | M |
| 5 | quoted names, both modes | G-5, T-2 | — | M |
| 6 | cross-file navigation | G-1, G-2, G-3, T-3 | 4 | L |
| 7 | schema vs `Main` | G-6 | — | S |
| 8 | routine + SHARED completion | C-1, C-2 | 4 | M |
| 9 | filterText | C-3 | 8 | S/M |
| 10 | message builder + did-you-mean | E-1, E-8, E-10 | — | L |
| 11 | damage tolerance | E-2, E-7 | 10 | L |
| 12 | LOGICAL adjudication | E-3 | 10 (if message route) | M |
| 13 | unknown CALL check | E-4 | 4, 10 | M |
| 14 | undeclared reads | E-5 | 4, 10 | L |
| 15 | same-file rename | N-1a | 3 | M |
| 16 | cross-file rename | N-1b, G-4 | 4, 6, 15 | L |
| 17 | quick fixes | E-9 | 10–14 | L |
| 18 | static tree completion | C-5 | — | M |
| 19 | tree-backed clause state | C-6 | 8 | L |

**Why this order:** 1–3 cost almost nothing and make everything else
comfortable (green base, shared extractor). 4 is the *only* true infrastructure
task — three phases consume it — so it precedes everything cross-file. 5–7 are
correctness repairs that don't wait on anything. Completion (8–9) follows the
index change it rides on. The message pass (10–12) is the user-visible heart of
the ELM goal and needs no dependencies beyond the phase, while the new checks
(13–14) deliberately come *after* it because their messages should use the
did-you-mean utility and share the wording conventions. Rename is sequenced
late on purpose: the safety story ("renaming SHARED breaks siblings") only
holds once 16 can actually see all files, and 15's explicit refusal makes the
interim state safe rather than silently wrong. Quick fixes last so they fix
final, well-worded diagnostics.

**Mapping check (nothing dropped):** C-1→8 · C-2→8 · C-3→9 · C-4→2 · C-5→18 ·
C-6→19 · C-7→3 · G-1→6 · G-2→6 · G-3→6 · G-4→16 · G-5→5 · G-6→7 · E-1→10 ·
E-2→11 · E-3→12 · E-4→13 · E-5→14 · E-6→3 · E-7→11 · E-8→10 · E-9→17 ·
E-10→10 · N-1→15+16 · N-2→4 · T-1→1 · T-2→5 · T-3→6 · T-4→3. There is no G-7
in the review.

## Global verification gate (end of every phase)

```
npm test
ESQL_LSP_NO_GRAMMAR=1 npm test        # fallback tests must run, grammar-only skip
npm run grammar:test                  # + generate/npm ci dance if grammar.js changed (task 12)
npm run smoke:stdio -- --expect-grammar
scripts/record_demo.sh                # both modes, once completion UX changed (phases 2, 7)
npx npm@10 ci --dry-run               # after any dependency change
npm run verify:package                # before any tag
```
