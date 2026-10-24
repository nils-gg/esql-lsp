# ISSUES.md — findings from testing the LSP against real-world ESQL

Tested 2026-10-23 against 103 `.esql` files from the 11 repositories listed at the
bottom, and re-tested 2026-10-24 on the same corpus with a second probe that
checks protocol invariants instead of opinions (range validity, symbol
containment, references monotonicity, the semantic-token stream, ghost URIs,
out-of-range positions, incremental round trips, latency). **Round 2 found nine
more, I-14 … I-22, and all nine are fixed; Round 3 (2026-10-24) closed the two
big round-1 leftovers: I-3** — all eleven construct families adjudicated against
the ACE 12.0.x reference, ten shipped as grammar rules, one (`OutputRoot.[<+1]`)
adjudicated NOT-ESQL and still rejected on purpose — **and I-6**, semantic checks
inside a damaged region. Still open from round 1: **I-12** (the multi-line
`Syntax error.` span quality) and **I-13** (cross-file `SHARED`/`CALL`), which
need a decision rather than a fix. The sections below the status table are
history.

Every item was reproduced twice: once on a real file, once on the minimal snippet
printed inline, so this document stands on its own without the corpus or the
probe scripts (both lived in `/tmp`).

**Grammar items are recorded, not fixed.** Per `AGENTS.md` /
`tree-sitter-esql/VERIFICATION.md`, the IBM ACE 12.0.x railroad diagram — not
real-world usage — adjudicates whether the grammar or the sample is wrong. Real
code is frequency evidence, nothing more. Items marked *[clear bug]* are not a
reference question and can be fixed directly.

Severity: **Critical** = the feature silently does not work · **High** = wrong
result on ordinary code · **Medium** = noise / missing feature on real code ·
**Low** = polish.

---

## Round 2 (2026-10-24) — nine new findings, all nine fixed

Round 1 asked "does the server answer, and is the answer near the right text".
Round 2 probed the surfaces that question cannot reach: every returned range
re-checked against the document, `selectionRange` ⊂ `range` and children ⊂ parent,
`includeDeclaration=false` never exceeding `true`, the semantic-token stream
decoded and measured against line lengths, requests for a document that was
never opened, positions outside the document, an incremental edit and its undo,
and the wall-clock cost of a request. New items:

| item | sev | one line | measured then | status, re-measured 2026-10-24 |
|---|---|---|---|---|
| I-14 | **Critical** | answering `workspace/semanticTokens/refresh` with "method not found" **kills the server** | unhandled `ResponseError`, exit 1, 0.23 s after every grammar-mode start; the request is sent to clients that never asked for it and its promise is never handled | **fixed** — sent at most once, only to a client that declared `refreshSupport`, only after `initialized`; promise caught, and `unhandledRejection` logs instead of killing. 3 e2e cases; heuristic mode sends none |
| I-15 | High | hover resolves a name to the **first declaration in the file**, not the one in scope | 16 of 40 use sites name the wrong routine, 1 also shows the wrong type; go-to-definition at the same cursor is right 39/40 → the two features disagree | **fixed** — 0 of 40 wrong routine, 0 wrong type; definition still contains the in-scope declaration at 40/40, so the two features now agree at every probed cursor |
| I-16 | High | completion offers declared names that are **not in scope** | 264 of 339 probed positions, in 28 of 94 files, 658 foreign names; worst position offers 20 | **fixed** — 0 of 339 grammar-mode and 0 of 879 heuristic-mode positions offer a `Declared:` item whose scope excludes them |
| I-17 | Medium | the same completion **label appears 2–3 times** | 228 duplicates in 100 of 103 files; 277 items → 244 labels on one real file | **fixed** — worst position 260 items / 260 labels / **0** exact duplicates; probe reports no `COMPLETION-DUPES` anywhere (228 → 0) |
| I-18 | Medium | `\r` counts as content: ranges and tokens **run one column past EOL** on CRLF files | 7 corpus files; 202/4187 semantic tokens, 63 symbol ranges, 1 diagnostic | **fixed** — 0 of 14,969 corpus tokens past EOL, 0 symbol ranges, 0 diagnostics, both modes |
| I-19 | High | a lone-`\r` file **loses the outline**, differently in each mode | grammar: 1 of 3 symbols + 3 misleading errors at 0:0; heuristic: positions the client cannot reproduce, hover null | **fixed** — one module under LF / CRLF / CR / LF+BOM: same 3 symbols, 0 diagnostics, hover answers at the client's own position, both modes |
| I-20 | Medium | with 2+ documents open, **every request re-parses and re-analyses** the file | hover 0.81 ms → 11.44 ms, completion 0.42 ms → 10.96 ms; `analyzeDocument` is ~13× the parse | **fixed** — alternating across 3 open documents: hover median **0.64 ms**, completion **0.61 ms** (was 11.44 / 10.96) |
| I-21 | Medium | diagnostics have no `source` and no `code` | 100 % of them, both modes (63 grammar / 7 heuristic corpus findings) | **fixed** — every finding is `source: "esql"` + one of 9 codes; probe reports no `DIAG-NO-SOURCE` (63 / 7 → 0) |
| I-22 | Low | capability and lifecycle hygiene | `save: true` with no handler; hierarchical symbols always; `{esql:…}` honoured only in `didChangeConfiguration`; JS stack text in `-32603` | **fixed** — no `save` advertised; symbols answer the declared shape; `{esql:…}` unwrapped at initialize too; a 12-case malformed-request battery over stdio answers `-32602` with a sentence and nothing else |

Corpus total after the fixes, same probe and the same 103 files: **0 violations**
(327 in grammar mode and 299 in heuristic mode before the fixes), 103/103
documents publishing diagnostics in both modes, slowest first diagnosis 609 ms
grammar / 371 ms heuristic, 5,492 + 5,508 feature requests at 0.9 / 1.1 ms
average, no request over 250 ms, both servers exiting 0 — and the only error
responses in the whole run are the sixteen `-32602` answers (eight per mode) to
the deliberately malformed requests the probe sends.

Round 1's fixes held up under the new probe: 103 files opened in **one** session
all published diagnostics (slowest 622 ms, and 103/103 in heuristic mode too,
slowest 361 ms), and the incremental `didChange` round trip works in both modes
(inserted `DECLARE` appears in the outline, hover answers on it, the
undeclared-name warning follows the edit, undo restores the exact outline).
Volume, both modes together: 11,000 requests, 0 timeouts, 0 JSON-RPC errors, 0
unexpected server-originated notifications other than the refresh in I-14, no
request over 250 ms, clean `shutdown`/`exit`. The verified non-issues are listed
at the bottom so nobody re-derives them.

---

## Status after this round of fixes (2026-10-23)

Ten of the thirteen are fixed; I-3 is the grammar work this document exists to
queue up, and I-6 / I-13 each need a decision. Measurement is the same corpus,
same serial probe (one document at a time — see I-1), both modes.

| item | status | what proves it |
|---|---|---|
| I-1 | **fixed** | per-URI `Map<uri, Timeout>`; new e2e case opens three broken files in one burst and asserts all three publish (restoring the old single timer makes that case time out) |
| I-2 | **fixed** | `comment: /\/\*(?:[^*]|\*+[^*/])*\*+\//` + `test/corpus/comments.txt`; corpus scan: files where a comment swallowed code 1 → **0**, hidden lines 151 → **0** |
| I-3 | **fixed** (round 3) | all 11 families adjudicated against 12.0.x pages — 10 shipped as grammar rules with corpus tests, family J (`OutputRoot.[<+1]`) adjudicated NOT-ESQL and deliberately still rejected; corpus scan 27 damaged → **1** (the J file). Full verdict table in `tree-sitter-esql/VERIFICATION.md` |
| I-4 | **fixed** | `nameRange()` adds `match.index`; heuristic symbols whose `selectionRange` did not hold their own name 168/344 → **0/344**, and after the fix all 670 (grammar) / 674 (heuristic) symbols are exact |
| I-5 | **fixed** | `paramSegments()` / `locatedRoutineParams()` read a header across lines; `symbols.ts` now consumes `routinesFromSource()`; definition + references asserted on a split header in **both** modes |
| I-6 | **fixed** (round 3) | tree path descends ERROR regions (`underDamaged`) and mines names/SET targets/routines from damaged code, one `Syntax error.` per outermost region; unclosed-module outlines agree across paths (`equal: true` on Case13); unit + e2e (real stdio, grammar path proven) + fallback tests |
| I-7 | **fixed** | one hint per routine, none when the scope never mentions `Properties`; corpus 51 hints → **0**; unit + stdio e2e + settings-toggle cases |
| I-8 | **fixed** | `XMLNS_RE` needs a following `.` and rejects `XMLNSC`; both `NamespaceDecl` spellings are now negative tests; corpus 2 → **0** |
| I-9 | **fixed** | whole-file `(`/`[` depth, `SELECT` as a continuation word, operator at the start of the next line; range spans the statement; corpus 13 hints → **0**, genuine misses still flagged |
| I-10 | **fixed** | quoted declares read from the raw line (range = the name, quotes excluded) and `wordAtPosition()` resolves quoted names for hover/definition/references; ghost `EXTERNAL` symbols 4 → **0**. The four real quoted names now exist — in heuristic mode (674 symbols vs grammar's 670), so the outline divergence that is left in those 4 files is I-3/H, not a fallback bug |
| I-11 | **fixed** | hover for a module (kind + contained routines), hover/definition/references for `BROKER SCHEMA` with dotted-segment matching. Measured in **both** modes: Module hover 0/117 → **117/117**, Namespace hover/definition/references 0/50 → **50/50**, and every one of the 670 (grammar) / 674 (heuristic) symbols answers definition, references and hover at its own advertised position |
| I-12 | partially fixed | no more token names in messages (`expected a data type here`, `expected a field reference here`); the multi-line `Syntax error.` span quality is still open |
| I-13 | open | needs the workspace-index decision (see the note at the end) |

Corpus effect on findings, 103 files, both modes (third column re-measured
2026-10-24 after the round-3 grammar + I-6 work; `corpus-probe.js` again
reported **0** protocol violations in both modes, 103/103 published):

| mode | files with findings | findings | what is left |
|---|---|---|---|
| grammar | 41 → 29 → **5** | 111 → 63 → **8** | 1 × `Syntax error.` on the NOT-ESQL `[<+1]` file (I-3/J, by design), 4 `FailureCount` (I-13), 3 × `Main() contains neither RETURN nor PROPAGATE` |
| heuristic | 26 → 4 → **4** | 73 → 7 → **7** | the same 4 + 3 — zero syntax complaints |

Those 7 were each read back and are **true positives**: `FailureCount` is I-13,
and the three `Main()`s really do fall off the end (`TransformExceptionHandler`,
`Sender`'s `InitNoSequenceRetry` module, `MQGetDemo_MF_RemoveMQHeaders`). The
heuristic path no longer warns about anything valid on this corpus.

One honest regression to record: `npx tree-sitter parse` now reports **27** files
with ERROR/MISSING where it reported 26. The comment fix did not break anything —
it made `Routing_using_memory_cache.esql`'s 151 lines visible for the first time,
and that code uses constructs the grammar does not have (family K). A file that
parses "clean" because its body was mistaken for a comment is not a clean file.
(Round 3 closed this too: the family rules shipped and the same scan now reports
**1** file — the `[<+1]` one.)

---
---

## How it was tested

```
# 103 files: 86 in the working trees + 17 extracted from .zip/.bar archives
git clone --depth 1 …                   # 11 repos
find . -iname '*.esql'                                                # 86
for z in $(find . \( -name '*.zip' -o -name '*.bar' \)); do
    unzip -o "$z" '*.esql' -d _from-archives/$(basename "$z" .zip) ; done   # +17
```

The server was driven over a **real stdio session** (`bin/esql-lsp.js`) by a
hand-written LSP client, in both analysis modes (grammar, and
`ESQL_LSP_NO_GRAMMAR=1`). Per file: `didOpen` → diagnostics → `documentSymbol` →
`definition`/`references`/`hover` at every symbol's own `selectionRange` →
`completion` at sampled identifiers → `semanticTokens/full` → `didClose`.
Separately: incremental `didChange` (range edits, versions 1→4), a tree-sitter
ERROR/MISSING scan, and a comment-node scan. Each returned range was re-read
against the file text, which is what catches offset/UTF-16 mistakes.

Corpus character: 100 pure ASCII + 3 with non-ASCII characters (one of them CJK in
a comment), 7 files with **CRLF** line endings, 0 with a lone `\r`, 0 with a UTF-8
BOM, all valid UTF-8; largest file 296 lines / 12.2 KB. The first draft of this
document claimed "0 CRLF" — that was the measurement, not the corpus: reading the
files through a text mode with universal newlines converts `\r\n` to `\n` on the
fly; reading the same files as bytes finds 7 (see I-18).
`tongyy/iib-official-samples` and `abughali/ace-openapi3-sample` have **no `.esql`
in their working trees** — their ESQL is inside archives: `Healthcare.zip` (13
files) and `Scribble.zip` (1) from the former, `TomorrowsWeather.zip` (1) from the
latter. Nothing in the corpus was embedded in `.msgflow`/`.subflow`.

---

## I-1 · Critical · one shared debounce timer: only the *last* document opened gets diagnostics

**Fixed.** `src/server.ts` keeps `debounceTimers: Map<uri, Timeout>` and clears/rearms only that URI's timer; the two bulk loops now call `revalidateAll()`, which arms one timer per document. Pinned by the e2e burst case, verified to fail against the old single-timer implementation.

`src/server.ts:71` declares a single `debounceTimer`, and `scheduleDiagnostics()`
(`src/server.ts:94-108`) does `if (debounceTimer) clearTimeout(debounceTimer)`
before arming a new one — for **any** URI. So within each `DIAGNOSTICS_DEBOUNCE_MS`
(300 ms) window only the last URI scheduled is ever validated; the other
documents keep whatever they had, which after `didOpen` is nothing at all.

Measured, same two files, same server build:

| scenario | result |
|---|---|
| 1 document open | 1 diagnostic published |
| 2 documents open back-to-back | first document: **no diagnostics ever** |
| same 2 documents, 700 ms apart | both correct |
| 3 documents open while the grammar is still loading | only the last is re-validated → **grammar-mode syntax errors never appear for the others** |

The same single-timer pattern breaks the two bulk re-validation loops that exist
precisely to fix a late grammar: the `initialized` handler
(`src/server.ts:142-150`) and `initGrammar().then(…)` (`src/server.ts:255+`) both
loop `for (const doc of textDocuments.all()) scheduleDiagnostics(doc.uri)` — each
iteration cancels the previous one, so exactly one open document is refreshed.

Why it matters: this is the normal case, not an edge case — restore a session,
open a folder, or restart the language server and N tabs fire `didOpen` in one
burst. It also masked 41 files' worth of real diagnostics in my first corpus pass
(a whole-corpus run reported "0 diagnostics on 103 files"), which is how I found
it. Everything counted in this document had to be re-measured one document at a
time.

Fix direction: `Map<uri, Timeout>` keyed per document (clear/rearm only the timer
for that URI), and in the bulk loops arm one timer per URI instead of relying on
`scheduleDiagnostics`. Add an e2e test that opens three broken files in one burst
and asserts all three publish.

```esql
# a.esql                                  # b.esql
CREATE COMPUTE MODULE A                   CREATE COMPUTE MODULE B
    CREATE FUNCTION Main() RETURNS BOOLEAN    CREATE FUNCTION Main() RETURNS BOOLEAN
    BEGIN                                     BEGIN
        SET mysteryVar = 1;                   SET OutputRoot = InptuRoot;
        RETURN TRUE;                          RETURN TRUE;
    END;                                      END;
END MODULE;                               END MODULE;      # ← both must report; only b does
```

---

## I-2 · Critical · *[clear bug]* a block comment swallows the code after it

**Fixed** in `grammar.js` (C-comment shape, no external scanner needed). Regenerated, refreshed through `npm ci`, pinned by `tree-sitter-esql/test/corpus/comments.txt` (three cases: code between two blocks, star runs, block + line comment on one line). Side effect: family K, below.

`grammar.js:1319` — `comment: $ => /\/\*[\s\S]*?\*\//`. Tree-sitter lexes token
regexes with a DFA (leftmost-**longest**); a lazy quantifier is not lazy there, so
`[\s\S]*?` behaves greedily and one comment token runs from the first `/*` to the
**last** `*/` in the file. Everything in between is invisible to the parser and —
because no `ERROR` node is produced — nothing reports it.

Real file, `ot4i/esql-code-coverage-tool/sample/MessageRouting/Routing_using_memory_cache.esql`
(205 lines, parses with **zero** ERROR/MISSING nodes):

```
(routine_body [3,1] - [168,4]
  (kw_BEGIN)
  (comment [4,2] - [165,4])      ← 11 "/*" and 11 "*/" inside ONE comment node
  (esql_statement (return_statement …))
  (kw_END))
```

151 lines of real statements collapse into a comment. Consequence in the editor:
`Variable1`, `Variable2`, `Variable3` and `refToInvoice` have no outline entry,
no hover, no definition, no references, no semantic colouring — while the same
file in heuristic mode lists all four. Only 1 of the 103 corpus files hit it
(few real files use two block comments), but 11 lines reproduce it:

```esql
CREATE COMPUTE MODULE CommentSwallow
    CREATE FUNCTION Main() RETURNS BOOLEAN
    BEGIN
        /* first block */
        DECLARE a INTEGER;        -- grammar mode: 'a' does not exist
        /* second block */
        DECLARE b INTEGER;
        SET b = a + 1;
        RETURN TRUE;
    END;
END MODULE;
```

Outline: grammar mode → `CommentSwallow / Main / b`; heuristic mode → also `a`.
Diagnostics: none, either mode.

Fix: a comment regex that cannot cross `*/` (the classic
`\/\*[^*]*\*+([^/*][^*]*\*+)*\/`), or an external scanner. After the change:
`npx tree-sitter generate`, `npm ci` at the root (the grammar-copy trap), plus a
corpus test with two block comments and live code between them.

---

## I-3 · High · grammar rejects 26 of 103 real files (25%)

**Fixed 2026-10-24 (round 3)** — every family adjudicated against the live
ACE 12.0.x reference; verdicts, page ids and the shipped rules are in
`tree-sitter-esql/VERIFICATION.md` ("Construct-family adjudications"). Ten
families were GRAMMAR-INCOMPLETE and shipped with corpus tests; family J
(`OutputRoot.[<+1]`) is **NOT-ESQL** and stays rejected on purpose. The scan
below is the state when this was written — the re-scan after the fixes is
**102 clean, 1 damaged**, and that one file is the J case.

Tree-sitter ERROR/MISSING scan when this was written: **77 clean, 26 damaged**.
Through the server those damaged files produced **35 × `Syntax error.`**,
**15 × `Missing syntax: expected 'kw_BIT' here.`** and **1 × `expected
'identifier' here.`** on code the ACE compiler accepts. After I-12 the last two
read `expected a data type here.` / `expected a field reference here.`, and the
re-scan is **76 clean, 27 damaged** with 40 `Syntax error.`: the I-2 comment fix
made `Routing_using_memory_cache.esql`'s body visible, and that body contributes
five ERROR regions (family K, below). Every family listed here is a real
construct, appears in more than one file, and each repro was confirmed with
`npx tree-sitter parse` (exit 1).

| # | construct | hits / files | status |
|---|---|---|---|
| A | `DECLARE <name> NAMESPACE 'uri';` | 15 / 13 | new |
| B | `PROPAGATE TO TERMINAL 'x' MESSAGE … [EXCEPTION …] [FINALIZE …] [DELETE …]` | 7 / 5 | new |
| C | `POSITION(x IN y)` | 7 / 5 | known limitation 1 |
| D | `TRIM(LEADING\|TRAILING\|BOTH x FROM y)` | 4 / 3 | known limitation 1 |
| E | `OVERLAY(x PLACING y FROM 1)` | 4 / 4 | known limitation 1 |
| F | `ASBITSTREAM(… [OPTIONS …] [ENCODING …] [CCSID …] [SET … TYPE … FORMAT …])` | 4 / 4 | new |
| G | `SUBSTRING(x FROM y [FOR z])`, `SUBSTRING(x AFTER y)` | 4 / 4 | known limitation 1 |
| H | `DECLARE "quoted-name" EXTERNAL CHARACTER;` | 4 / 4 | new |
| I | `SET t[] = SELECT cols, <kw-expr> AS alias FROM …` | 1 / 1 | new |
| J | `SET OutputRoot.[<+1] = …` | 1 / 1 | new |
| K | `ROUTING : BEGIN ATOMIC … END ROUTING;`; qualified column + lowercase `as` in a `SELECT` list | 5 / 1 | new (found after I-2 was fixed) |

**A — namespace-prefix DECLARE.** `declare_statement` (`grammar.js:421-437`)
requires `$.datatype` after the name, and models `NAMESPACE` only as a *clause*
after a datatype. The prefix form has no production, so the parser repairs by
inserting a datatype: the diagnostic is `Missing syntax: expected 'kw_BIT' here.`
(see I-9). Worst: `tool-iib/HelloWorld_V1_IS/gen/SayHello_Request_Response_BuildResponse.esql:8-9`
(two in a row), plus every HL7/XML sample.
```esql
DECLARE ns NAMESPACE 'http://www.example.org/demo/';
CREATE COMPUTE MODULE C5
    CREATE FUNCTION Main() RETURNS BOOLEAN
    BEGIN
        DECLARE body REFERENCE TO InputRoot.XMLNSC.ns:Payload;
        RETURN TRUE;
    END;
END MODULE;
```
Expected: parses; `ns` becomes a symbol (real files then use `ns:Payload`).

**B — PROPAGATE without `WHERE`.** `propagate_statement` (`grammar.js:841-858`)
puts `MESSAGE`/`ENVIRONMENT`/`EXCEPTION` under a mandatory `kw_WHERE`, but IBM's
own transport code writes `PROPAGATE TO TERMINAL 'out' MESSAGE OutputRoot;` —
plain `PROPAGATE TO TERMINAL 'out';` parses fine, which pinpoints the clause.
Evidence: `_from-archives/Healthcare/Healthcare/healthcare/Receiver.esql:148`,
`…/transport/TransportSender.esql:121,136`, `…/transport/TransportReceiver.esql:68,83`,
`…/healthcare/ReceiverExceptionHandler.esql:85`, `…/Tests/Applications/ReceivingApplication.esql:35`.
```esql
PROPAGATE TO TERMINAL 'out1' MESSAGE OutputRoot DELETE NONE;
PROPAGATE TO TERMINAL 'out2' ENVIRONMENT OutputLocalEnvironment MESSAGE InputRoot
        EXCEPTION OutputExceptionList FINALIZE NONE DELETE NONE;
```
Expected: parses. Note for whoever adjudicates: making `WHERE` optional touches
the `FINALIZE`/`DELETE` tails — expect an LR conflict to resolve.

**C/D/E/G — SQL clause-style functions.** Absent from the grammar entirely:
`grep -i` for `POSITION|TRIM|OVERLAY|SUBSTRING` in `grammar.js` returns nothing,
so only the comma-call forms exist. Already tracked as *Known limitations 1* in
`VERIFICATION.md`; what this pass adds is that real HL7/MLLP and SOAP code uses
them constantly, and each use costs a red squiggle over valid code.
Evidence: `TransportReceiver.esql:49,53`, `TransportSender.esql:203,207`,
`TestApplication/Flows/Subflows/AddMLLPBytes.esql:28,42`,
`…/TrimMLLPBytes.esql:28,32,52,59`, `tool-iib/EsqlFunctions_V1_IS/gen/Split.esql:23,28`,
`…/countryCodeCheck_Request_Response_Compute.esql:10`,
`tool-iib/EmailAttachmentsToFile_APP/…/AcquireEmail_CheckForAttachments.esql:13`,
`_from-archives/TomorrowsWeather/…/ForecastRequest_Compute.esql:9`,
`ace-http-mq-request-reply/*/…_Create_Outbound_Message.esql:22,24,25` (`OVERLAY`).
```esql
SET p = POSITION('ab' IN 'xxabxx');
SET t = TRIM(LEADING 0x0B FROM InputRoot.BLOB.BLOB);
SET s = OVERLAY('0000' PLACING 'ab' FROM 1);
SET s = SUBSTRING('abcdef' FROM 2 FOR 3);
SET s = SUBSTRING('abcdef' AFTER 'b');
```

**F — bitstream conversion functions.** `ASBITSTREAM`, `ASJSON`, `TOJSON`,
`TOMIME`, `BITSASBLOB`, `NPCANONICAL` appear **zero times** in `grammar.js`. These
are the everyday serialisation calls in ACE message flows, so this is the family
most likely to bite beyond the corpus. Both option orders fail, and so does the
minimal one-option form:
```esql
DECLARE bs BLOB ASBITSTREAM(OutputRoot.MRM
    ENCODING InputRoot.Properties.Encoding
    CCSID InputRoot.Properties.CodedCharSetId
    SET ReceiverMessageSet TYPE ReceiverMessageType FORMAT 'IDOC');
SET messageBLOB = ASBITSTREAM(InputRoot.MRM CCSID 1208);
```
Evidence: `_from-archives/Healthcare/…/Receiver.esql:133`,
`…/ReceiverExceptionHandler.esql:72`, `…/TransportSender.esql:83`
(`… OPTIONS BitStreamOpts ENCODING … SET SenderMessageSet …`),
`tool-iib/EsqlFunctions_V1_IS/gen/countryCodeCheck_Request_Response_Compute.esql:20`.

**H — quoted DECLARE names.** `identifier: /[_a-zA-Z][_a-zA-Z0-9]*/`
(`grammar.js` ~line 355) excludes double-quoted names; a `quoted_identifier` rule
exists but is only wired to `.NET` assembly clauses. All four files in
`ace-http-mq-request-reply` (`CorrelIdClient/CorrelId_Create_Outbound_Message.esql:13`,
`CorrelIdUsingBody/…:13`, `Sha1HostnameClient/…:8`, `Sha1HostnameWithTimeoutClient/…:8`)
start with `DECLARE "script-encoded-hostname" EXTERNAL CHARACTER;` — the documented
way to bind a name with characters an identifier cannot hold.
```esql
DECLARE "script-encoded-hostname" EXTERNAL CHARACTER;
```
Expected: parses, and the symbol is the name without quotes (see I-8 for what the
fallback invents today).

**I — `AS alias` after a keyword-valued expression.** Alias support exists in
`_select_item`, but `CURRENT_TIMESTAMP AS X` is refused at the `AS`:
`tool-iib/GlobalCacheDemo_V1_APP/…/loadCache_MF_Compute.esql:11`.
```esql
SET Environment.DB.EMPLOYEE[] = SELECT
    p.EMPNO, p.FIRSTNAME, CURRENT_TIMESTAMP AS UPDATED_AT
    FROM Database.WMBOWNER.EMPLOYEE AS p;
```

**J — the `[<+1]` "append" index.** Real code: `tool-iib/RetryFailuresGeneratedInThisAPP/…/catch_handler_sf_Compute.esql:12`
→ `SET OutputRoot.[<+1] = InputBody;`. `_path_name` covers `[n]`, `[]`, `[*]`,
`{expr}`, `"quoted"`, not `[<+1]`; the parser inserts an `identifier` and the
message is `Missing syntax: expected 'identifier' here.`

**K — the constructs that were hiding inside a comment.** Found only after I-2
was fixed, by parsing `esql-code-coverage-tool/sample/MessageRouting/Routing_using_memory_cache.esql`
honestly (151 lines of it had never been parsed). Unadjudicated, and the first one
is not even obviously ESQL — which is exactly why frequency here proves nothing:

```esql
ROUTING : BEGIN ATOMIC -- beginning of atomic block
    ...
END ROUTING ;
```

`ROUTING :` and `ATOMIC` are ERROR nodes (labels and `BEGIN ATOMIC` have no
production), `END ROUTING` is an ERROR node, and three lines lower
`SELECT S.QUEUE_MANAGER as queueManagerName, … FROM CacheQueueTable.DestinationData[] as S`
puts two more ERROR nodes over the select list — `S.QUEUE_MANAGER` (a qualified
column) and the lowercase `as` alias — so this file belongs to family I as well.

---

## I-4 · High · *[clear bug]* heuristic mode: routine symbols point one character early

**Fixed.** `nameRange(line, name, m)` returns `m.index + m[0].indexOf(name)`. `test/symbols.test.ts` asserts `textAt(selectionRange) === symbol.name` for every symbol of a tab-indented file — fallback always, tree path whenever the addon is loaded.

In `ESQL_LSP_NO_GRAMMAR=1` mode, **168 of 177 routine symbols** (across **98 of
103 files**) have a `selectionRange` starting one column left of the name, so the
range covers the preceding whitespace:

```
PaymentInit_BuildIframeUrl.esql  Main                textAt=' Mai'  sel=3:16-3:20
PaymentInit_BuildIframeUrl.esql  CopyMessageHeaders   textAt=' CopyMessageHeader'  sel=21:17-21:35
```

Root cause, `src/symbols.ts:33-37`:
`nameRange(line, name, matchText)` returns `matchText.indexOf(name)` — an offset
*inside the match text* — without adding the match's own column. On a tab-indented
line `\bCREATE` starts at character 1, so every name in it lands one column early.
Unindented headers are fine, which is why `CREATE PROCEDURE` at column 0 and the
module/`BROKER SCHEMA` symbols look healthy, and why `src/definitions.ts:156`
(`lines[i].indexOf(name, m.index + 'CREATE'.length)`) is correct: the two
extractors disagree.

User-visible effect: hover, definition and references asked at the position the
outline itself advertises return nothing — clicking a routine in the outline does
nothing in exactly the mode users without a C toolchain get. Fix: add `m.index`.
Add a test with a tab-indented routine that asserts
`textAt(selectionRange) === symbol.name` on both paths.

---

## I-5 · High · heuristic mode loses parameters of a multi-line routine header

**Fixed.** `definitions.ts` walks the lines a header spans (`paramSegments`, `splitParams`, `locatedRoutineParams`) and reads `RETURNS` from them too; `symbols.ts` dropped its own copy of the header pattern and reads `routinesFromSource()`, which is why the outline and go-to-definition can no longer disagree about a split header.

`declarationsFromSource()` reads one line at a time and `FN_PARAMS_RE` needs the
whole `(...)` on that line, so a header written the way Paymob writes them yields
**no** parameter symbols. Grammar mode finds them all.

```esql
    CREATE FUNCTION getPolicyProperty(
        IN policyName   CHARACTER,
        IN propertyName CHARACTER)
    RETURNS CHARACTER
    LANGUAGE JAVA
    EXTERNAL NAME "com.example.PolicyReader.getProperty";
```
Grammar outline: `getPolicyProperty, policyName, propertyName` · heuristic:
`getPolicyProperty` only. Real: `propertyName` missing in
`Paymob-Payment-Gateway-Integration/PaymobIntegrationApp/PaymentInit_LoadUserData.esql`,
`errorCode`/`errorMessage` missing in `…/PaymentInit_validateInput.esql`.

---

## I-6 · Medium · grammar mode hides semantic checks inside a damaged region

**Fixed 2026-10-24 (round 3).** The tree path is authoritative *inside* an
ERROR node: `visit()` in `parser.ts` keeps descending every ERROR child with a
sticky `underDamaged` flag, mining declarations, SET targets and routines from
damaged code, while reporting exactly one `Syntax error.` at the outermost
damaged region instead of one per nested node. `routinesFromSource()` (the
pattern path) extends an unclosed BEGIN body to module end so the two paths
agree on the buffer-mid-typing state — `test/symbols.test.ts` compares the two
outlines and reports `equal: true` on the Case13 file below. Unit, symbols and
stdio-e2e coverage in all three failure shapes (unclosed module, damaged
routine body, declaration only inside damage); fallback-mode tests included,
as required.

The unclosed-module state — a buffer mid-typing — is where the fallback is
supposed to carry on (`AGENTS.md`: keep the two paths in agreement). It doesn't:

```esql
CREATE COMPUTE MODULE Case13
    CREATE FUNCTION Main() RETURNS BOOLEAN
    BEGIN
        DECLARE declaredVar INTEGER;
        SET declaredVar = 1;
        SET neverDeclared = declaredVar;
        SET OutputRoot = InptuRoot;          # file ends here, no END
```

| mode | diagnostics | outline |
|---|---|---|
| grammar | `Syntax error.` · missing `END MODULE` · `Main() body is not closed with END;` | `Case13` only |
| heuristic | missing `END MODULE` · **`Variable 'neverDeclared' …`** · `Main() body is not closed with END;` | `Case13 / Main / declaredVar` |

Clean files agree in both modes, so this is specific to the ERROR region: once the
tree path rebuilds the header (`damagedModuleInfo()`), it stops descending, and the
semantic checks that run off declared names silently go quiet — including the
symbols themselves. Whichever path is right, they must not disagree.

---

## I-7 · Medium · `OutputRoot.JSON.Data` hint fires once per `SET` (51 hints, 15 files)

**Fixed.** `checkOutputRootProperties()` works on scopes (`hintScopes()`): at most one hint per routine, at its first offending `SET`, and none at all if the routine never mentions `Properties`. The message says “in this routine” because that is what it now checks.

`checkOutputRootProperties()` (`src/diagnostics.ts:320-340`) looks 10 lines back for
a Properties copy and hints on **every** matching line. In
`Paymob-Payment-Gateway-Integration/PaymobIntegrationApp/PaymentInit_BuildPaymentKeyRequest.esql`
that is **18 identical hints** in one file; `PaymentInit_BuildOrderRequest.esql` 9,
`PaymentInit_BuildSuccessResponse.esql` 7, `PaymentInit_ErrorHandler.esql` 4, and
1-2 each in 11 more files. Several of those files (request builders for MQ/HTTP
replies) never touch `Properties` anywhere, so the hint is not even the right
advice.

Fix direction: one hint per routine (or per module), reported at the first
offending line; and drop it when the routine contains no `Properties` reference at
all, since that is a deliberate request-building node.

---

## I-8 · Medium · `Parser 'XMLNS' is deprecated` fires on a namespace *declaration prefix*

**Fixed.** `XMLNS_RE = /\bXMLNS\b(?!C)(?=[ \t]*\.)/i` — the deprecated parser is only ever written `XMLNS.`, while the namespace-declaration idiom writes `xmlns:tns` (no dot) and `XMLNSC` is excluded by the lookahead. Both corpus spellings are negative tests.

Two false positives, both the standard `(XMLNSC.NamespaceDecl)xmlns:tns` idiom:

```esql
SET OutputRoot.XMLNSC.tns:SayHelloResponse.(XMLNSC.NamespaceDecl)xmlns:tns = tns;
```
* `tool-iib/HelloWorld_V1_IS/gen/SayHello_Request_Response_BuildResponse.esql:10`
* `tool-iib/EsqlFunctions_V1_IS/gen/splitString_Request_Response_Compute.esql:15`

`XMLNS_RE` matches the `xmlns` in `(XMLNSC.NamespaceDecl)xmlns:tns`, which is a
prefix name, not the deprecated parser. Fix: require the match to be in a tree
position (e.g. `Root.XMLNS.` / `XMLNS.` immediately after a root) and exclude the
`NamespaceDecl` slot; add both spellings as a negative test.

---

## I-9 · Medium · heuristic "missing semicolon" hints on valid code, with nonsense ranges

**Fixed.** `checkMissingSemicolons()` is whole-file: it tracks `(`/`[` depth across lines, treats `SELECT` and the other clause keywords as “the statement goes on below”, and looks at the next non-blank line for a leading `||`, `&&`, `+`, … (`CONTINUATION_START_RE`, because Healthcare's `TransportSender` writes the operator there). The range covers the statement text.

13 hints in 6 files (Heathcare + two tool-iib files), all on multi-line
`ASBITSTREAM(...)` / `SELECT ...` continuations that end correctly. The reported
range is the *tail* of a word mid-expression:

| file | hints | `text` under the range |
|---|---|---|
| `…/transport/TransportSender.esql` | 5 | `'geSet'`, `'ts'`, `'Set'`, `'ER)'`, `'ype'` |
| `…/healthcare/Receiver.esql` | 2 | `'RM'`, `'Set'` |
| `…/healthcare/ReceiverExceptionHandler.esql` | 2 | `'MRM'`, `'eSet'` |
| `…/transport/TransportReceiver.esql` | 2 | `'eSet '`, `'eSet '` |
| `tool-iib/…/loadCache_MF_Compute.esql` | 1 | `'CT '` |
| `tool-iib/…/SendExcelFile_MF_Compute.esql` | 1 | `'B) '` |

Two bugs in `checkMissingSemicolon()` (`src/diagnostics.ts:302-320`): the range is
`lineRange(lineIdx, line, trimmed.length, line.length)` — i.e. from the trimmed
length to the raw length, which is not the end of the statement — and
`STATEMENT_START_RE` fires on continuation lines inside a multi-line call, which it
must not. Grammar mode emits **0** of these hints on the same files, so this is
heuristic-path noise landing on exactly the files where the grammar already fails
— the worst combination.

---

## I-10 · Medium · outline divergence: heuristic mode invents an `EXTERNAL` variable

**Fixed.** The quoted form is matched on the raw line, but only where the masked view confirms the `DECLARE` is live code, and the generic pattern is skipped for that line — so nothing invents `EXTERNAL`. The recorded range is the name without its quotes, which is also what `wordAtPosition()` resolves, so the symbol hovers and navigates.

In the four `ace-http-mq-request-reply` files the heuristic lists a `Variable`
named **`EXTERNAL`**. It comes from `DECLARE_RE` on the line I-3/H rejects —
`DECLARE "script-encoded-hostname" EXTERNAL CHARACTER;` — where the quoted name
breaks the capture and `EXTERNAL` becomes the "name". A symbol that hovers, is
navigable to, and appears in "Rename" for a name that is not in the file.
Outline parity holds on 96/103 files; the 7 divergences are this (4), I-5 (2) and
I-2 (1).

---

## I-11 · Medium · no hover for modules; `BROKER SCHEMA` is inert in both modes

**Fixed.** Hover answers for a module (kind, declaration line, the routines inside it) and for the schema (any dot-segment of the name, since `wordAt` stops at dots); `definitionAt`/`referencesAt` gained the schema in both paths. `modulesFromSource()` moved into `definitions.ts` with `kind` and the full span, so hover and the outline read one source.

Across 666 symbols in the corpus:

* **Module** (117 symbols): hover returns nothing. Definition and references work.
* **Namespace** (50 `BROKER SCHEMA …` symbols): hover, definition **and**
  references all return nothing, in both modes. `BROKER SCHEMA com.x.y` is the
  file's identity and the name real flows reference; "go to schema", "find
  references" and a hover card (`BROKER SCHEMA com.x.y`, module type, parser
  version) are all cheap and missing.

---

## I-12 · Low · error message quality

**Partially fixed.** `expectedPhrase()` in `src/parser.ts` names the construct the token belongs to (through the parent node) instead of the grammar token: `Missing syntax: expected a data type here.` on `DECLARE ns NAMESPACE '…'` instead of `expected 'kw_BIT' here.`, while punctuation still prints as itself. Still open: the bare `Syntax error.` spanning several lines from the middle of a statement.

* `Missing syntax: expected 'kw_BIT' here.` (15×) and
  `Missing syntax: expected 'identifier' here.` (1×) leak tree-sitter token names.
  For I-3/A the message is not just ugly but wrong: it tells the reader a `BIT`
  was expected on a `DECLARE ns NAMESPACE '…'` line.
* The other failures are a bare `Syntax error.` spanning **multiple lines from the
  middle of a statement** — e.g. 35 of them across the corpus, several spanning 6
  lines. Pointing at the start of the construct (or the recovered point) and
  naming the statement would make them actionable.

---

## I-13 · Low · no cross-file resolution (design gap, needs a decision)

**Open — needs a decision, not a patch.** A workspace index (declarations per file, refreshed on save, feeding `workspace/symbol` and the undeclared-variable check) is the only correct fix; suppressing every name that appears after a `CALL` would silence a real bug class to hide four findings. Either way it is a feature, so it was not folded into this round.

`_from-archives/Healthcare/…/ReceiverExceptionHandler.esql` gets
`Variable 'FailureCount' is used in SET but never declared` at **4** lines
(67, 96, 170, 172). It is declared twice in sibling files:
`…/healthcare/Receiver.esql:23` and `…/transport/TransportReceiver.esql:24` as
`DECLARE FailureCount SHARED INTEGER 0;`. Same shape: `CALL CopyMessageHeaders()`
where the procedure lives in another `.esql` of the same application.

There is no workspace index — every document is an island — so any `SHARED`
declaration (an explicitly cross-flow feature) or `CALL` into another file is
unresolvable, and the undeclared-variable check therefore produces false
positives on real multi-file applications. Either add a lightweight workspace
index (`workspace/symbol` + a declaration cache keyed by file), or suppress the
undeclared-variable warning for names declared `SHARED` elsewhere / any name used
only after a `CALL`.

---

## I-14 · Critical · the server dies when a client answers `workspace/semanticTokens/refresh` with "method not found" *[clear bug]*

**Minimal repro** (a 30-line client, no corpus needed): `initialize` with
`capabilities: { textDocument: { semanticTokens: { requests: { full: true } } } }`
— no `workspace` section — then answer whatever request the server sends with
`{ code: -32601, message: 'Unhandled method …' }`, which is what a client that
does not implement a server→client request must do.

```
server asked the client for workspace/semanticTokens/refresh → answered -32601
node_modules/vscode-jsonrpc/lib/common/connection.js:565
                        responsePromise.reject(new messages_1.ResponseError(…));
ResponseError: Unhandled method workspace/semanticTokens/refresh
    at handleResponse (…/vscode-jsonrpc/lib/common/connection.js:565:48)
SERVER EXITED code=1
```

The server asks for the refresh when the grammar finishes loading
(`src/server.ts:300`) — 0.23 s after `initialize` on this checkout — in grammar
mode only (heuristic mode never loads the grammar, so it never crashes: the crash
is exclusive to the configuration most users get). Every request the client makes
after that gets a closed pipe, which clients report as "server crashed on
startup".

Three separate things went wrong, all in one line of code:

1. the server never advertises `workspace.semanticTokens.refreshSupport`, and
   never looks at the capability the client did send — the comment above the call
   says *"No-op-safe when the client did not declare refresh support"*, but
   `connection.languages.semanticTokens.refresh()` is not a no-op, it is
   `connection.sendRequest(…)` (`vscode-languageserver@9.0.1`,
   `lib/common/semanticTokens.js:13-15`);
2. the returned promise is discarded, so the client's error response becomes an
   **unhandled rejection**, which is fatal on Node ≥ 15;
3. the request is sent at all — a server must not send a request the client did
   not declare support for.

Expected: no `workspace/semanticTokens/refresh` unless
`params.capabilities.workspace?.semanticTokens?.refreshSupport`, advertised in
return, and the promise caught either way. Fix both (the capability check is the
correctness fix, the `.catch()` is the "nothing in this file may ever kill the
server" fix). A `process.on('unhandledRejection')` that logs through
`window/logMessage` is worth adding for the same reason: this is the failure mode
for every future server→client request (`client/registerCapability`,
`workspace/configuration`), not just this one.

**Fixed 2026-10-24.** `src/server.ts` keeps `clientWantsSemanticTokensRefresh`
from `initialize`, advertises `workspace.semanticTokens.refreshSupport` back only
when the client declared it, and `requestSemanticTokensRefresh()` sends at most one
refresh per process, and only once *both* the grammar has landed *and* the client
has sent `initialized` — a server→client request before that is out of order. The
promise is caught either way; `unhandledRejection` / `uncaughtException` now log
through `window/logMessage` instead of ending the process, because this failure
mode belongs to every future server→client request, not just this one. Proven by
three e2e cases: a client without the capability records `serverRequests == []`; a
client that answers `-32601` is alive and correct afterwards; heuristic mode never
sends one.

---

## I-15 · High · hover resolves a name to the *first* declaration in the file, not the one in scope *[clear bug]*

**Minimal repro** (fails in both modes):

```esql
CREATE COMPUTE MODULE TwoRoutines
    CREATE FUNCTION First() RETURNS BOOLEAN
    BEGIN
        DECLARE shared INTEGER 1;
        SET shared = shared + 1;      -- hover here → *in `First()`*   (correct)
        RETURN TRUE;
    END;

    CREATE FUNCTION Second() RETURNS BOOLEAN
    BEGIN
        DECLARE shared INTEGER 2;
        SET shared = shared * 3;      -- hover here → *in `First()`*   (WRONG)
        RETURN TRUE;
    END;
END MODULE;
```

`src/hover.ts:124` takes `declarations.find((d) => eq(d.name))` — the first
match in file order. The *declaration that is in scope at the cursor* is a
different thing, and the server already knows how to find it:
`definitions.ts`'s `definitionAt()` does. So hover and go-to-definition disagree
at the same cursor.

Measured over the corpus with a scope-aware probe (a use site of each declaration
in turn, with positions that are not inside a string/comment taken from the
server's own mask, so the probe cannot blame the server for a position it is
correct not to answer). Names declared in two or more distinct scopes: **24** in
103 files; **68** of their 168 use sites are shadowed by an earlier declaration in
another scope (10 files). Probing one use per declaration — 40 probes:

| probe result | count |
|---|---|
| hover named the **wrong enclosing routine** | **16** |
| hover showed a different **type** than the declaration in scope | 1 |
| go-to-definition returned exactly the in-scope declaration | **39** |
| go-to-definition returned two candidates for a name declared twice | 1 |
| go-to-definition returned somewhere else | **0** |

So `definition` is scope-correct and `hover` is not — 16 positions where the two
features, asked at the same cursor, describe different declarations.

| file | name | cursor is in | hover says | definition says |
|---|---|---|---|---|
| `Paymob…/PaymentInit_BuildOrderRequest.esql` | `I` (decl. 25, 40) | `CopyMessageHeaders` @43:9 | `Main` ✗ | 40:10 ✓ |
| `Paymob…/PaymentInit_LoadUserData.esql` | `POLICYNAME` (7, 24) | `Main` @26:66 | `getPolicyProperty` ✗ | 24:13 ✓ |
| `…Healthcare/healthcare/Receiver.esql` | `MSHENV` (37, 88) | `BuildACKMSA` @92:5 | `BuildACKMSH` ✗ | 88:32 ✓ |
| `…Healthcare/healthcare/ReceiverExceptionHandler.esql` | `MESSAGENUMBER` (14, 105) | `GetLastExceptionDetail` @113:9 | `Main` ✗ | 105:69 ✓ |
| `…Healthcare/healthcare/ReceiverExceptionHandler.esql` | `MESSAGETEXT` (14, 105) | `GetLastExceptionDetail` @114:9 | `Main` ✗ | 105:96 ✓ |
| `…Healthcare/transport/TransportReceiver.esql` | `ENV` (38, 172) | `CheckMSHFields` @183:7 | `Main` ✗ | 172:10 ✓ |
| `…Healthcare/transport/TransportSender.esql` | `INPUTBLOB` (195, …) | `Main` @203:54 | `PrependMLLPByte` ✗ — and shows `BLOB` where the name in scope is `REFERENCE TO` | 195:10 ✓ |
| `…Healthcare/transport/TransportSender.esql` | `ACKCODE` (264, …) | `CheckMSA` @271:7 | `Main` ✗ | 264:31 ✓ |
| `…Healthcare/transport/TransportSender.esql` | `ERRORTEXT` (264, …) | `CheckMSA` @275:7 | `Main` ✗ | 264:54 ✓ |
| `…Healthcare/Tests/Applications/ReceivingApplication.esql` | `ERRORTEXT` (10, 73) | `BuildACKMSA` @81:43 | `Main` ✗ | 73:79 ✓ |
| `…Healthcare/Tests/Applications/ReceivingApplication.esql` | `INPUTMSH` (75, …) | `BuildACKMSA` @79:47 | `BuildACKMSH` ✗ | 75:10 ✓ |
| `ace-read-credentials…/ReadFlow_ReadCredsFromESQL.esql` | `USERNAME`, `PASSWORD`, `APIKEY`, `CLIENTID`, `CLIENTSECRET` | `Main` @23:23…23:139 | `getCredentials` ✗ (5 names on one line) | 15:10, 16:10, 17:10, 18:10, 19:10 ✓ |

The same first-match rule applies to routines (`src/hover.ts:118`): with two
modules each containing a `Main()`, hovering the **second** module's `Main` header
reports `*in module \`First_Module\`*` (grammar mode) or `*at document level*`
(heuristic mode — `routinesFromSource()` does not fill `moduleName`, so the owner
line is lost even when the match is right). Module names themselves resolve
correctly (`Second_Module` hovers and jumps to line 8), because a name collision
there would be the rarer case — the ownership line above them is what is wrong.

The one definition that was not a single exact hit is not a scope bug either:
`ReceivingApplication.esql` returns **both** candidates for `ACKCODE`
(`10:8, 73:57`) where the name really is declared twice, and a `Definition`
response may carry several locations.

Fix in `hover.ts`: pick the innermost enclosing `scope` for the position (falling
back to the outermost enclosing one, then to file order when the position is
outside every scope), and fill `moduleName` in the fallback extractor so the owner
line is right in heuristic mode too. The helper belongs in `definitions.ts` next
to `definitionAt()`, because completion (I-16) needs the same answer —
`AGENTS.md`: fix a quirk in one place or the four features disagree.

**Fixed 2026-10-24.** The scope question moved into `definitions.ts`, next to
`definitionAt()`, as `declarationAt()` (innermost scope containing the position,
the declaration under the cursor winning over any other, file order only as the
last resort), `enclosingRoutine()` ("who owns this line") and `routineByNameAt()`
("which `Main()` is this"). `hover.ts` calls those three and nothing else, and
`routinesFromSource()` fills `moduleName` so the fallback names the owner too.
Covered by `test/hover.test.ts` (both modes: the shadowed-`value` case and the
two-`Main()`-modules case, with the heuristic half never skipped) and
`test/definitions.test.ts` (the fallback now computes real scopes: each `value`
visible in its own routine, invisible in the other, nothing visible past
`END MODULE`).

---

## I-16 · High · completion offers declared names that are not in scope *[clear bug]*

`buildCompletionItems()` is handed every declared name in the document
(`doc.declaredNames`) and offers all of them at every position; nothing consults
the `scope` each entry carries. Measured over the corpus by building the answer
the server would really return — `linePrefix` = the text before the position, as
in `connection.onCompletion` — at 339 positions in 94 files (every use site of a
name that is declared more than once, plus one `SET` target per routine):

* **264 of those positions** (in **28 files**) offered at least one name whose own
  `scope` excludes the position;
* **658** distinct foreign names, summed over files;
* worst single position: **20** foreign names —
  `Paymob…/PaymentInit_BuildPaymentKeyRequest.esql` line 76 character 17, inside
  `CopyEntireMessage`, prefix `"SET OutputRoot "`, offers
  `paymobBaseUrl, authToken, paymobOrderId, amountCents, currency, integrationId,
  firstName, lastName, email, phone, apartment, floor, street, building, city,
  country, state, postalCode` (all declared in `Main`) **plus `I, J`** (declared in
  `CopyMessageHeaders`).

The scope data itself is right — `Main`'s declarations carry `scope 5–63`,
`I`/`J` carry `65–73`, and the `CopyEntireMessage` body is line 75–77, so the
filter is one comparison away. A file that grows routines degrades the list
linearly, which is the opposite of what a scope-aware completion should do.
Fix: filter `declaredNames` to those whose `scope` contains the position
(module-level and `SHARED` declarations stay visible everywhere inside their
module), reusing the containment test that `definitionAt` already uses. The
fallback path needs the same filter from `declarationsFromSource()`, whose entries
carry a `scope` too.

**Fixed 2026-10-24.** `buildCompletionItems()` takes the cursor position and
filters declared names through `visibleDeclarationsAt()` — the containment test
`definitionAt()` already used — so a position inside `CopyEntireMessage` sees only
what that routine can see, while module-level and file-level declarations stay
visible everywhere inside their module. Omitting the position keeps the old
"everything in the document" behaviour, which the unit tests use deliberately, and
the fallback path filters `declarationsFromSource()` entries the same way. e2e
asserts `myVar` is offered inside `Main()` and absent at a position past
`END MODULE`, in both modes.

---

## I-17 · Medium · the same label is offered two or three times in one list *[clear bug]*

**228 findings in 100 of the 103 files** in the round-2 probe (which asks one
identifier position per file); asked at every position sampled in the second pass
the same duplication appears in **103 of 103** files. It happens in *both* modes,
because the list behind it is static data, not analysis. On a real file (
`PaymentInit_BuildPaymentKeyRequest.esql`, an ordinary identifier position, prefix
`"SET OutputRoot "`): **277 items, 244 distinct labels, 33 redundant entries —
32 labels offered twice and one (`EXISTS`) three times.** The 33 redundant labels
are the same set in every file that reaches a full list, plus `FLOOR` in this one:

| label | offered as |
|---|---|
| `CHARACTER, INTEGER, FLOAT, DECIMAL, BOOLEAN, BLOB, BIT, DATE, TIME, TIMESTAMP, INTERVAL, ROW, REFERENCE, NAMESPACE` (14) | `Keyword` "ESQL keyword" **+** `Type` "ESQL data type" |
| `EXISTS` | `Function` + `Keyword` + `Snippet` — **three times** |
| `ENVIRONMENT` | `Keyword` + `Variable` (message tree variable) |
| `FUNCTION, PROCEDURE, DECLARE, IF, WHILE, FOR, CASE, PROPAGATE, THROW, PASSTHRU` | `Keyword` + `Snippet` |
| `SUBSTRING, CAST, COALESCE, LOG, CARDINALITY` | `Function` + `Snippet` |
| `FLOOR` (in a file that declares `DECLARE floor CHARACTER`) | `Function` "FLOOR(x)" + `Variable` "Declared: CHARACTER" |

`src/completion.ts`'s `general` branch concatenates
keywords + tree vars + functions + types + declared names + snippets and only
prefix-filters the result. Fix: merge on the upper-cased label with a fixed
preference (declared name > tree variable > function > type > keyword), keep the
snippet as a separate *suggestion* only when the label is not already a keyword
or function, and put the declared variable first when it shadows a built-in
(that one is genuinely useful information, not a duplicate).

**Fixed 2026-10-24.** `dedupeByLabel()` in `src/completion.ts` keeps one item per
label, preferring the form that says the most: a declared name of this document
first, then snippet > function > type > keyword. Matching is on the **exact**
label, deliberately not case-folded — `IF` (keyword, inserts `IF`) and `if`
(snippet, expands a block) are two completions that merely look alike, and folding
them made one of the two vanish. On the file above the worst position now returns
260 items / 260 distinct labels and **0** exact duplicates (was 277 items, 244
distinct labels, 33 redundant); 18 case-variant pairs remain, by design, because
their insert text differs. Asserted in `test/completion.test.ts` ("offers each
label at most once", plus a case that a declared name shadowing a built-in is
offered as the *declaration*).

---

## I-18 · Medium · `\r` is treated as content: ranges run one column past EOL on CRLF files *[clear bug]*

7 of the 103 files are CRLF (all 7 from the IBM HL7 samples in
`_from-archives/Healthcare/…`). A client's line does **not** include its line
terminator, so every range that reaches "the end of the line" is one column too
long for those files:

* **grammar mode**: **202 of 4187** semantic tokens on those 7 files end one
  column past EOL, all of them `comment` tokens — the grammar's comment token
  includes the `\r` (`SegmentFilters.esql`: `comment at 0:0+90` on an 89-character
  line). A client paints one column past the end of the line;
* **heuristic mode**: **63 `documentSymbol` ranges** on the same 7 files, e.g.
  `SegmentFilters.esql` symbol `Main` → *end char 6, line is 5 characters*,
  `Receiver.esql` symbol `healthcare` → *end char 25, line is 24*. Symbol **names**
  are still exact (round 1's I-4 fix holds), only the ranges that reach end of line
  are off by one;
* **the one diagnostic** that reaches end of line, in
  `Sender.esql` (line 80): `Main() contains neither RETURN nor PROPAGATE.` → *end
  char 40, line is 39 characters*. It comes from the same scanner path, so it is
  off by one in grammar mode too — grammar mode only replaces the *syntax*
  diagnostics, the semantic checks always run on the heuristic scan.

Three sources, all of them line splitting that keeps the `\r`:

* `src/scanner.ts:100` — `masked.split('\n')`, so every heuristic range derived
  from a line's length includes the `\r`;
* `src/definitions.ts:311,500` — `rawLines` for the quoted-name search;
* the grammar's comment token, for the semantic-token side.

Fix on the server side without touching the grammar: a `linesOf(source)` helper
that splits on `/\r\n|\r|\n/`, used everywhere a line length becomes a character
offset. Fix the comment token too (its length should stop before the line
terminator) — that is a one-character regex change, and it also softens I-19.

**Fixed 2026-10-24.** Both sides. `src/scanner.ts` has `linesOf()`, splitting on
`/\r\n|\r|\n/` and excluding the terminator — the split
`vscode-languageserver-textdocument` does — and `scan()` returns `lines` from the
masked text plus `rawLines` from the original (the mask blanks the quoted names the
`definitions.ts` search needs), so every range built from a line length is measured
against the line the client has. The masking loop treats `\r` as a terminator too,
which is what let a `--` comment blank the rest of a CR-only file. The grammar's
`line_comment` is `/--[^\r\n]*/` (regenerated, `npm ci`), and
`semanticTokensForTree(tree, source)` clamps every token to the client's line
length whatever the grammar matched, so "a token ends on the line it started on" is
a protocol guarantee now. Covered by `test/parser.test.ts`: the LF / CRLF / lone-CR
matrix, token clamping, and every declared-name, SET-target, symbol and diagnostic
range inside its own line, on both paths.

---

## I-19 · High · a lone-`\r` (CR-only) file loses the outline, in both modes *[clear bug]*

The same nine-line module as I-18, joined with a CR instead of an LF (no `\n`
anywhere):

| line ending | mode | symbols the client is told about | what else |
|---|---|---|---|
| LF | both | `EolProbe`, `Main`, `amount` | — |
| CRLF | both | `EolProbe`, `Main`, `amount` | positions correct (only I-18's one-column overrun) |
| **CR only** | grammar | **`EolProbe` only** | 3 diagnostics, all pinned at **0:0**: `Syntax error.`, `Module 'EolProbe' is missing its closing END MODULE;`, `Main() body is not closed with END;` — all three are wrong, the file is well-formed; 12 tokens, and on the variant that opens with a `--` comment **one** comment token 213 characters long, i.e. the whole file became a comment |
| **CR only** | heuristic | `EolProbe`, `amount` — **no `Main`** | `amount` reported at **line 0 character 92**; the client has that name at line 3 character 12 → **hover at the real position returns null**; 2 diagnostics at 0:0 |

Neither analysis path breaks a line at a lone `\r` (`tree-sitter` counts `\n`
only, and the heuristic splits on `\n`), so both collapse a CR-only file onto one
line — and every position they return is wrong for a client that *does* break
lines there (`vscode-languageserver-textdocument` splits on `\r\n | \r | \n`). The
two modes then lose different symbols, which is how the finding reads differently
depending on whether the reader has a C toolchain.

No corpus file is CR-only (measured: 0), so this is not a frequency finding — it
is the accidental output of an EOL conversion, a file copied through a Windows
`cmd` redirection, or an old Mac file, and the LSP's answer is "your well-formed
file is a syntax error and has no routines".

Fix (also kills I-18): normalise line endings once, where text enters the server —
`didOpen`/`didChange` hand the analysis `text.replace(/\r\n?/g, '\n')`, or one
shared `linesOf()` used by the scanner and `definitions.ts` plus normalised text
given to `parse()`. Removing a `\r` that immediately precedes a line break moves no
column, so every position stays aligned with the client; a lone-`\r` file gains the
lines the client already counts.

**Fixed 2026-10-24.** The heuristic side is `linesOf()` above; the tree side is
`parse()`, which substitutes `\n` for a lone `\r` before handing text to
tree-sitter — length-preserving, so no column moves, which is the argument this
section made. tree-sitter counts only `\n`, so without that bridge every row it
reports for a CR-only file is wrong; with it, one and the same module gives the
same outline, the same hover and **0** diagnostics under LF, CRLF and CR-only.
Asserted for both paths in `test/parser.test.ts`; the heuristic hover half of that
case runs even with `ESQL_LSP_NO_GRAMMAR=1`.

---

## I-20 · Medium · with two or more documents open, every request re-parses and re-analyses the file *[clear bug]*

`src/server.ts:92-98` keeps **one** parsed document, keyed by its whole text. Any
second open document evicts it, so each request pays for a fresh parse *and*
analysis. Measured over a real stdio session with 3 corpus files open
(12.5 KB + 7.7 KB + 3.3 KB), grammar mode:

| pattern | median | mean |
|---|---|---|
| hover, same document 20× in a row | **0.81 ms** | 1.98 ms |
| hover, alternating across the 3 documents | **11.44 ms** | 12.36 ms |
| completion, same document 20× | **0.42 ms** | 1.53 ms |
| completion, alternating across the 3 documents | **10.96 ms** | 11.73 ms |

(The first request of each run is cold in both columns, which is why the means are
close; the medians are the signal.)

The analysis, not tree-sitter, is the cost: on the biggest corpus file
(12.2 KB, 296 lines) `parse` is **2.4 ms** and `analyzeDocument` **26–31 ms**
across repeated runs — ~13× the parse — and it scales roughly linearly with the
size of one document: 12 KB → 26 ms, 49 KB → 74 ms, 148 KB → 206 ms,
370 KB → **495 ms** of analysis per request. `src/parser.ts` walks the tree with
`node.children`, and in `node-tree-sitter` 0.25.1 that property returns a **fresh
array of freshly allocated `SyntaxNode`s every time it is read** (the child nodes
themselves are identity-stable). Measured on `TransportSender.esql` (2300 nodes):

| walk | cost |
|---|---|
| parse only | 2.1 ms |
| one full walk, reading `children` once per node | 7.0 ms |
| the same walk reading `children` twice per node — what `childOf()` + a loop does (`src/parser.ts:262`, 17 `node.children` reads, 10 `childOf()` call sites) | 13.7 ms |
| a `TreeCursor` walk (`rootNode.walk()`) | 7.1 ms — no better |

So the win is not a different traversal API: it is **not walking at all per
request**, and reading `node.children` once per node instead of once per field.

Two things make it worse than it looks: `completionProvider.triggerCharacters`
includes `' '`, so completion is asked for on every space typed in the *visible*
document; and `didChangeContent` schedules diagnostics, so with N open documents
being cycled (a `workspace/symbol`-style sweep, an extension walking files, or
simply two files in a split view) each keystroke re-does the full walk.

Fix in two cheap steps: (a) cache by document, invalidated on `didChange`/
`didClose`, instead of one text-equality slot (the text itself is a fine key — the
current bug is only that there is one slot); (b) hoist `const kids = node.children`
in the walk so each node's child array is built once. Re-measure with this
document's numbers after each step.

**Fixed 2026-10-24**, step (a) only. `src/server.ts` keeps
`parseCache: Map<uri, { text, tree, analysis }>`: a request for an open document
reuses the tree and the analysis while its text is unchanged, `didChange` /
`didClose` drop the entry, and an edit re-parses exactly that document. Measured
over a real stdio session with the same three files open:

| pattern | before | after |
|---|---|---|
| hover, same document 20× in a row | 0.81 ms | 0.88 ms |
| hover, alternating across the 3 documents | **11.44 ms** | **0.64 ms** |
| completion, same document 20× | 0.42 ms | 0.63 ms |
| completion, alternating across the 3 documents | **10.96 ms** | **0.61 ms** |

Step (b) is in the tree too — one `node.children` read per node in the walk — but
it has to be said plainly that it did **not** move the measurable number:
`analyzeDocument` on `TransportSender.esql` is still ~13 ms, which is now paid
once per edit instead of once per request. The cache is the fix, the walk is a
small constant, and the 370 KB extrapolation above (495 ms per analysis) is
therefore a per-edit cost now rather than a per-request one.

---

## I-21 · Medium · diagnostics carry no `source` and no `code` *[clear bug]*

Every diagnostic in both modes: `source: undefined`, `code: undefined`. Corpus
count: **63** grammar-mode / **7** heuristic-mode diagnostics, 100 % of them
(the probe records one finding per diagnostic, so this is simply "all").
`src/diagnostics.ts` calls `Diagnostic.create(range, message, severity)` and
never passes the optional fields.

Consequences for a real user: the Problems pane shows no owner for the message
(so it cannot be told apart from another ESQL extension's, or from a linter),
`@sort source` / "exclude this source" / per-source colouring have nothing to
work with, and a client cannot offer a targeted suppression because there is no
stable code to suppress. Fix: `source: 'esql'` on every diagnostic plus a stable
`code` per check (`undeclared-variable`, `missing-end-module`,
`deprecated-xmlns`, `no-propagation`, `missing-semicolon`, `syntax-error`, …),
which also gives the settings table a natural second name and lets
`codeDescription` point at the README section.

**Fixed 2026-10-24.** Every diagnostic is built by one `diag()` helper in
`src/diagnostics.ts` — `Diagnostic.create(range, message, severity, code, 'esql')`
— so a future check cannot forget the fields the way the six call sites did.
`DiagnosticCode` is a closed union of nine codes that mirror the
`diagnostics.check*` setting names one-to-one (`syntax-error`,
`missing-end-module`, `module-no-main`, `no-propagation`, `unclosed-main`,
`undeclared-variable`, `deprecated-parser`, `missing-semicolon`,
`output-root-properties`), which is what gives the Problems pane something to
group by and the user something to suppress; the README lists them next to the
settings table. No `codeDescription` yet — the codes are stable, so a link can be
added later without touching any of them. Asserted three ways: in
`test/diagnostics.test.ts` on both paths including which codes actually fired, and
over a real stdio session in `test/e2e.test.ts`, where switching
`checkOutputRootProperties` off has to take exactly that code out of the published
set and leave the others.

---

## I-22 · Low · capability and lifecycle hygiene *[clear bug]*

Four small protocol honesty problems, all verified over stdio:

1. **`save: true` is advertised, and there is no save handler**
   (`src/server.ts:159`; `grep -n "onDidSave" src/` → nothing). A client that
   honours the advertisement sends `didSave` and gets silence. Either drop the
   advertisement or use it (a save is the natural moment to re-check a file a
   formatter touched).
2. **`documentSymbol` always answers the hierarchical shape.** Asked by a client
   whose capabilities say `documentSymbol: {}` (no
   `hierarchicalDocumentSymbolSupport`), the server still answers with
   `DocumentSymbol[]` — items carrying `range` + `selectionRange` (and
   `children` where there is nesting) and no `location` at all, which such a
   client cannot render. Measured on a real file: 2 items, DocumentSymbol shape,
   `grep location` over the response → nothing. The capability check is one line
   in `onDocumentSymbol`; `symbols.ts` already builds both shapes' worth of data.
3. **`initializationOptions` does not accept the `{ esql: … }` wrapper**, although
   `src/settings.ts` documents that both shapes are accepted ("the server accepts
   either `{ esql: {...} }` or the settings object directly"): with
   `{ esql: { diagnostics: { checkUndeclaredVariables: false } } }` at initialize,
   `Variable 'nobody' is used in SET but never declared` is still published;
   `didChangeConfiguration` with the same wrapper does silence it, because that
   handler unwraps (`src/server.ts:190`) and `onInitialize` does not
   (`src/server.ts:150`). Fix: unwrap in one shared place.
4. **Malformed parameters leak a JavaScript stack into a JSON-RPC message**
   instead of answering. A client that sends `hover` without `position`, or
   positions as strings (a JSON-only client), gets:
   `-32603 … Cannot read properties of undefined (reading 'line')`,
   `-32603 … Range#create called with invalid arguments[3, 1, 3, 7]`,
   `-32603 … Cannot read properties of undefined (reading 'uri')`.
   A guarded `position`/`textDocument` check returning `null` (or an
   `InvalidParams` error) would keep those messages in the protocol. The server
   never *died* on any of these, and answered every later request correctly —
   that part is good.

**Fixed 2026-10-24**, all four:

1. `save` is gone from the advertised `textDocumentSync`. Diagnostics come from
   didOpen/didChange, so a save notification would only re-publish what the last
   change already published; advertising it promised a handler that does not
   exist. Asserted in the main e2e session (`caps.textDocumentSync.save ===
   undefined`).
2. `onDocumentSymbol` answers the shape the client declared: `DocumentSymbol[]`
   with `hierarchicalDocumentSymbolSupport`, otherwise a flattened
   `SymbolInformation[]` where every entry carries its own `location` and the
   nesting becomes `containerName`, so nothing the flat shape can hold is lost.
   The heuristic-mode e2e session is a client that declares nothing and asserts
   the flat list; the grammar-mode session declares the capability and asserts the
   children; `scripts/smoke-stdio.js` declares it too, which is what makes its
   "routine nested inside the module" check mean what it says.
3. `unwrapSettings()` in `src/settings.ts` is called by both `onInitialize` and
   `didChangeConfiguration`, so `{ esql: { … } }` works in either place, and a
   client that sends something that is not an object still gets the defaults.
4. `documentFor()` and `viewPosition()` in `src/server.ts` guard all five
   document/position handlers. No `textDocument.uri`, or a `position` that is
   missing / non-integer / negative, is a malformed request and answers
   `-32602 InvalidParams` with a sentence a human can read — no V8 vocabulary, no
   stack. A line past the end of the buffer or a column past the end of the line
   is *not* malformed: that is a client whose text moved between sending and
   handling, and it answers `null` / `[]` rather than an error the editor pops up.
   Proven by a 12-case battery over stdio, which finishes by hovering a real
   symbol to show the session is still healthy.

The corpus probe had to be corrected to agree with this. It sends those same bad
positions to every file, and after the fix it counted the (correct) `-32602`
answers as `BOUNDS-negative-line` / `-char` violations — a warm re-run reported
984 of them and nothing else (492 + 492), i.e. the probe disagreeing with the
protocol rather than the server breaking it. The 0-violation figure above comes
from a re-run with the probe fixed, and the eight `-32602` responses it still
records are listed as the deliberate cases they are.

---

## Not issues (checked, behaving as designed)

Round 1 (2026-10-23). Two bullets were too broad; they are corrected in place
rather than deleted, because the round-2 probe is what corrected them.

* **No crashes from corpus traffic.** 103 files × both modes: 0 timeouts, 0
  unanswered requests, 0 malformed frames, 0 server stderr errors, clean
  `shutdown`/`exit`. *Corrected 2026-10-24:* the server does die, but not on
  corpus traffic — on a client that answers the refresh request (I-14).
* **No bad ranges in LF files.** 0 out-of-bounds ranges and 0 definition-text
  mismatches over every diagnostic, symbol, definition and reference returned; the
  UTF-8 files show no offset drift. *Corrected 2026-10-24:* that held because the
  corpus was assumed to be LF; on its 7 CRLF files ranges do overrun EOL by one
  column (I-18).
* **Incremental sync works.** Range edits (versions 1→4): after inserting a line,
  hover and definition follow the new positions; a newly introduced
  `SET typoTarget = 1;` warns at the right line, and undoing the edit removes it.
* `didClose` publishes an empty diagnostics array (103/103).
* **Completion is context-aware**: after `SET OutputRoot.` it offers tree/field
  names (`JSON XMLNSC MRM BLOB MIME Properties MQMD MQRFH2 HTTP…`), inside an
  identifier it offers the declared name, and it prefix-filters (`R…` at a `RETURN`
  position). Item counts of 250+ appear only at positions where a keyword/type
  list is a plausible answer.
* 5 files legitimately have no module (module-less ESQL: `CREATE PROCEDURE …
  LANGUAGE JAVA EXTERNAL NAME`, `DECLARE x SHARED ROW`,
  `DECLARE RETRY_AT_THIS_HOUR EXTERNAL INTEGER 20`) — the outline is right, not empty-by-bug.
  Each shape was also parsed on its own: `BROKER SCHEMA` + `DECLARE`, a
  `SHARED ROW` declaration, a `DECLARE … EXTERNAL`, and a
  `LANGUAGE JAVA EXTERNAL NAME "…"` routine all come back with 0 syntax issues and
  the right symbols. Only a top-level `SET` **outside** any routine is reported,
  and that really is not valid ESQL.
* Heuristic mode emits 0 semantic tokens: expected — tokens are produced from the
  grammar's `queries/highlights.scm`, so without the addon there is no source for
  them. The capability is advertised unconditionally (see the comment at
  `src/server.ts:131`), so a client will keep asking and get an empty result
  in that mode. That is the documented degradation, not a bug.
* True positives that kept working and should not be "fixed": missing `END MODULE`,
  `Main() body is not closed with END;`, `Main() contains neither RETURN nor
  PROPAGATE.` (correct — `Sender.esql`, module `InitNoSequenceRetry`, really falls
  off the end), undeclared variable in `SET` on a clean file.

Round 2 (2026-10-24), from the invariant probe — recorded so the next round does
not re-derive them:

* **Bulk open works at scale**: 103 documents in ONE session, 103/103 publish
  diagnostics, slowest 622 ms. (I-1's fix, confirmed in the situation that used to
  break it.)
* **Incremental `didChange` really moves the analysis**, in both modes, on 7
  representative files: inserting `DECLARE r2ProbeVar INTEGER 3; SET r2ProbeUse =
  r2ProbeVar;` puts `r2ProbeVar` in the outline, hover answers on it, the
  undeclared-variable check reports `r2ProbeUse` at the new line, and deleting the
  two inserted lines restores the outline **exactly**, name for name. Relevant to
  I-6 too: a *newly inserted* `DECLARE` inside the damaged
  `Routing_using_memory_cache.esql` **is** seen.
* **The empty answer has the right shape.** For a URI that was never opened, all
  six requests answer empty (`[]`, `null`, or `{"data":[]}` — an empty token
  stream is an object, not an array, so a naive "is the answer empty" test calls it
  an answer). Nothing errors for an unopened document.
* **Nonsense positions and nonsense parameters are survivable**: line past EOF,
  character 99999, negative line, negative character, a `didChange` whose range
  starts at line 9999, `references` with no `context`, `completion` with a numeric
  `uri`, `hover` before `initialize`, `$/cancelRequest`, a second `initialize`, a
  duplicate `didOpen` — no crash, and the next real request answers correctly. (The
  JSON-RPC *message* for malformed params is the problem, not the survival: I-22.4.)
* **Positions are UTF-16 code units, not bytes.** With an accent (`é`), a curly
  quote, three CJK characters or an emoji placed earlier on the same line as a
  `DECLARE`, the name is still reported at its real character column, hover answers
  there, `definition` points there, and no semantic token crosses EOL. A UTF-8 BOM
  changes nothing (same 3 symbols, 22 tokens, 0 diagnostics as without it).
* Completion asked for **inside a comment or a string literal** narrows to the one
  identifier being typed instead of offering the 250-item list. Not a bug: on
  masked text there is no prefix to expand.
* A symbol `range` spanning many lines (a module, a routine) is legitimate; a probe
  that flags "range longer than 50 lines" measures nesting, not a defect.

## Suggested order of work

**Round 2 (current).** I-14 (kills the server for every client that is not VS
Code; the fix is three lines) → I-15 + I-16 (one root cause each in `hover.ts` and
`completion.ts`; both need "which declaration is in scope at this position", so
add that helper to `definitions.ts` — `AGENTS.md`: fix a quirk in one place or the
four features disagree) → I-18 + I-19 (one `linesOf()` helper plus normalising line
endings at ingest: one change, two findings, testable with a synthetic file in both
modes) → I-17 (dedup the `general` list) → I-20 (uri+version cache first, the tree
walk second) → I-21 (`source` + `code`) → I-22 (protocol hygiene).

**Round 1 (still open).** I-3 families A–K, each after its railroad diagram is
read, starting with A/F/B (highest real-world frequency) → I-6 (parity inside
damaged regions — round 2 showed an inserted `DECLARE` *is* seen, so the gap is
narrower than first written) → I-12 (multi-line `Syntax error.` spans) → I-13
(needs a design decision).

---

## Repositories tested

`.esql` counts — in working trees: `code2blog/tool-iib` 45 ·
`trevor-dolby-at-ibm-com/ace-http-mq-request-reply` 20 ·
`AsmaaElawady/Paymob-Payment-Gateway-Integration` 12 ·
`ot4i/esql-code-coverage-tool` 2 · `trevor-dolby-at-ibm-com/ace-esql-read-env-var`
2 · `tdolby-at-uk-ibm-com/ace-demo-sap-unittest` 2 ·
`trevor-dolby-at-ibm-com/ace-user-variable-examples` 1 ·
`trevor-dolby-at-ibm-com/ace-read-credentials-in-flow` 1 ·
`trevor-dolby-at-ibm-com/ace-mq-reconnect` 1 (= 86).
Inside archives, extracted for the test: `tongyy/iib-official-samples`
`Technology/Industry/Healthcare.zip` 13 + `Applications/Scribble.zip` 1 ·
`code2blog/tool-iib` `DemoMappingNode_IS/CustomerService-pi-with-namespace-issues.zip`
2 · `abughali/ace-openapi3-sample` `project/TomorrowsWeather.zip` 1 (= 17).
Total 103 files. No `.bar` archive contained ESQL.

---

## Fix log (2026-10-23)

Verified on this machine: `npm test` (96 pass / 0 fail),
`ESQL_LSP_NO_GRAMMAR=1 npm test` (79 pass / 17 skip / 0 fail — only grammar-only
expectations skip),
`npm run grammar:test` (74 corpus cases), `npm run smoke:stdio -- --expect-grammar`,
and the tree-sitter CLI scan of all 103 files. `npm run verify:package` and the
Node 18/20/22 matrix still have to be run before tagging.

Where things ended up:

* `src/definitions.ts` is now the only place that knows what a declaration, a
  routine header (split or not) and a quoted name look like. `symbols.ts` stopped
  carrying its own `FN_RE` / `findBodyEndLine`, `completion.ts` its own use of
  `DECLARE_RE`, `hover.ts` its own cursor lookup. That is what keeps four features
  answering the same question the same way — I-4 and I-10 existed only because
  they didn't.
* Checks 4 and 6 in `src/diagnostics.ts` are whole-file / per-scope instead of
  per-line, which is where the 51 + 13 hints came from.
* `grammar.js`: only the `comment` token changed. Nothing was loosened for any
  family in I-3 — per `VERIFICATION.md` none of them should be until its diagram
  has been read. Family K went onto the same list rather than being special-cased,
  including the possibility that `ROUTING :` is not ESQL at all.
Feature answers over the corpus, asked at each symbol's own `selectionRange` — the
position the outline itself advertises, which is what a click in the outline sends:

| kind | before | after (grammar) | after (heuristic) |
|---|---|---|---|
| Function (177) | definition 177, references 177, hover 177 | unchanged | unchanged |
| Module (117) | hover **0** | hover **117** | hover **117** |
| Namespace (50) | definition 0, references 0, hover 0 | **50 / 50 / 50** | **50 / 50 / 50** |
| Variable | 322 / 322 / 322 | 326 / 326 / 326 | 330 / 330 / 330 |
| selectionRange holding exactly its own name | exact on the tree path already; on the fallback 168 of 344 routine/module symbols sat one column early (I-4) | 670 of 670 | 674 of 674 |

(The two Variable counts differ because the quoted declares of I-3/H exist on the
fallback path and not on the grammar path; 674 − 670 = the four
`ace-http-mq-request-reply` files.)

Method note, since it affects how to read the heuristic column: the grammar-mode
figures came from the stdio LSP probe (`r3-grammar.json` / `post3-grammar.json`);
the heuristic feature figures were taken in-process against `dist/` — same
`documentSymbols` / `definitionAt` / `referencesAt` / `hoverAt` entry points the
server calls, but without the JSON-RPC round trip. The finding counts for both
modes came from the probe, and the two paths were already compared against each
other by `test/symbols.test.ts`.

Corpus numbers are reproducible only one document per session — I-1 hid them
otherwise. The probe and scan scripts lived in `/tmp/esql-review/` and went with
it, so the figures above are quoted from the JSON they produced: `r3-*.json`
before, `post2-*.json` / `post3-*.json` after.

Two things to keep in mind while working on the rest:

1. After any `grammar.js` edit, `npm ci` at the repo root is what actually
   refreshes the parser the server and the root tests load. Skipping it produces
   the most confusing failure this repo has: the corpus tests pass against the new
   grammar while the server still parses with the old one.
2. I-13 is a feature decision. Until it is taken, `Variable 'FailureCount' is used
   in SET but never declared` on a multi-file application is a *known* false
   positive — and the three `Main()` findings in the same corpus are real bugs in
   those files. Do not fix the first by loosening the check until it also stops
   catching the second.

---

## Fix log (2026-10-24) — round 2

Verified on this machine before committing: `npm test` (114 pass / 0 fail),
`ESQL_LSP_NO_GRAMMAR=1 npm test` (92 pass / 22 skip / 0 fail — only
grammar-only expectations skip, every fallback assertion runs),
`npm run grammar:test` (74 corpus cases), `npm run smoke:stdio --
--expect-grammar` (grammar mode actually loaded), and the round-2 corpus probe on
all 103 files in both modes. **Not** run this round: `npm run verify:package` and
the Node 18/20/22 matrix — both are still required before a tag.

Where things ended up:

* **One place answers "what is in scope at this cursor".** `declarationAt()`,
  `visibleDeclarationsAt()`, `enclosingRoutine()` and `routineByNameAt()` in
  `src/definitions.ts`, used by hover, completion and definition alike. The
  fallback now computes real scopes (`routineSpans` / `moduleSpans` /
  `moduleScope`) instead of calling the whole file one scope, which is what made
  the two paths disagree on a shadowed name rather than only on scope edges.
* **Completion answers twice less often, on purpose.** Names are filtered by the
  cursor's scope, and `dedupeByLabel()` keeps one item per *exact* label with a
  preference order (this document's declarations > snippet > function > type >
  keyword). Case-folding the label was tried and is wrong: `IF` the keyword and
  `if` the snippet expand to different text.
* **The client's line model is now the server's.** `linesOf()` splits
  `/\r\n|\r|\n/` without keeping the terminator, `scan()` exposes `rawLines` for
  the readers that need the original text, the masking loop ends a `--` comment at
  `\r`, `parse()` substitutes `\n` for a lone `\r` before tree-sitter sees the
  text (length-preserving, so no column moves), and `semanticTokensForTree(tree,
  source)` clamps every token to the line length the client has. Text is never
  normalised at ingest — only for the tree.
* **One `diag()` builds every diagnostic**, with `source: 'esql'` and one of nine
  stable codes that mirror the setting names, so a check is addressable without
  matching its message.
* **A per-document parse cache**, invalidated by `didChange` / `didClose`. This is
  the whole I-20 win; the child-array hoist in the tree walk is real but worth
  nothing measurable, and the write-up says so.
* **Capabilities say what the server does.** No `save`; document symbols in the
  shape the client declared; `{ esql: … }` accepted at initialize as well as in
  `didChangeConfiguration`; bad requests answered with `InvalidParams`, positions
  off the end answered with "nothing".
* `grammar.js`: `line_comment` only, now `/--[^\r\n]*/`, regenerated with
  `npx tree-sitter generate` and refreshed through `npm ci` — the copy in
  `node_modules/tree-sitter-esql/src/parser.c` is byte-identical to the committed
  one. Nothing was loosened for any I-3 family.

Three probe false positives were removed rather than reported as findings, and one
of them was big enough to change a headline number:

1. The completion scope probe compared offered *labels* against declarations
   case-insensitively, so a name that is legitimately visible (`USERNAME`,
   declared in this routine) was counted as leakage because an unrelated parameter
   spelled `username` somewhere else in the file is not visible there. The
   replaced probe asks a real stdio server and checks only the items the server
   itself marks `Declared: …` — which is the claim a client can actually act on.
   That turned "201 positions leaking" into the true 0.
2. The robustness probe sends negative line/character to every file and counted any
   reply as a violation; after fix 4 above the correct answer is `-32602`, which it
   now accepts (and still rejects anything else).
3. `r2-probe.js` wants `--corpus=<dir>`, not `--corpus <dir>`: the space form
   silently falls back to scanning its own directory. That is how a 123-file run
   (the corpus plus scratch `.esql` files in `/tmp`) produced 984 phantom
   violations, and it is worth checking the `files:` count in any probe output
   before believing its totals.

Still open, all from round 1: **I-3** families A–K (read the diagram first, per
`VERIFICATION.md`), **I-6** (semantic checks inside a damaged region), **I-12**
(multi-line `Syntax error.` spans), **I-13** (cross-file `SHARED` / `CALL` —
a feature decision, not a bug).

## Fix log (2026-10-24) — round 3: probe archive, I-6, codeDescription, I-3 families A–K

**The probes are archived.** The seven measurement scripts behind every number in
this document now live under `scripts/probe/` with a shared corpus-argument
helper, a `README.md` (including the `--corpus` vs `--corpus=` incident that
produced 984 phantom violations), and `probe:*` npm aliases. All seven were
re-run against the 103-file corpus and reproduce the round-2 numbers they are
cited for (0/339 + 0/879 out-of-scope completion offers, the damaged-file scan,
CRLF ranges, latency, the robustness battery).

**I-6 — the tree path now keeps working inside damage.** `visit()` in
`src/parser.ts` descends every child of an `ERROR` node with a sticky
`underDamaged` flag: declarations, SET targets and routines are mined from
damaged code (so the undeclared-variable check and the outline stay alive in
the buffer-mid-typing state), while exactly one `Syntax error.` is reported for
the outermost damaged region instead of one per nested node. The pattern path
matches: `routinesFromSource()` extends an unclosed `BEGIN` body to module end,
mirroring the fallback rule. `test/symbols.test.ts` compares the two outlines on
the Case13 file and reports `equal: true`; unit + symbols + diagnostics + a real
stdio e2e case cover the three shapes, and every fallback assertion runs in
`ESQL_LSP_NO_GRAMMAR=1` mode too.

**Diagnostics now carry a `codeDescription`** (extends I-21): every diagnostic
the server publishes links to `https://github.com/nils-gg/esql-lsp#diagnostics`,
asserted by the shared `assertAddressable` helper in both modes and by an e2e
case; README documents the link target.

**I-3 — all eleven families adjudicated against the live ACE 12.0.x reference.**
Verdicts, page ids and reasoning: `tree-sitter-esql/VERIFICATION.md` →
"Construct-family adjudications". Shipped (each with corpus tests): namespace
alias DECLARE and quoted DECLARE names (A, H — quoted names grammar-only, both
analyzer paths still index plain identifiers); `PROPAGATE` without `WHERE` and
with repeatable MessageSources (B — `WHERE` is an orphaned IBM page caption;
kept tolerated-optional); the keyword-clause calls `POSITION`/`TRIM`/`OVERLAY`/
`SUBSTRING`/`ASBITSTREAM` (C/D/E/G/F — `TRIM` needed a flat choice, `ASBITSTREAM`
a `repeat1` so the clauseless call keeps its old node, and `_call_arg` slots are
individually optional for IBM's documented `f(tree,,1208,,,,opts)` positional
form); `SELECT expr AS name` (I); labelled `[NOT] ATOMIC` blocks (K). **Family J
(`SET OutputRoot.[<+1] = …`) is NOT-ESQL** — `<n>` counts from the end — and the
one file using it still reports a syntax error, which is correct. PROPAGATE
`DECIDEMODE`-style clauses and the `ASJSON`/`TOMIME` family have no 12.0.x page
and were left exactly as rejected as they were.

**A green that was not green.** Round 2's insertion-marker test (`expected ';'`
after `DECLARE x INT 0`) had been passing against a *stale*
`node_modules/tree-sitter-esql/` copy; the real committed parser recovers that
input by swallowing the next statement. Found only by parsing the fixture with a
HEAD-grammar CLI checkout. The test now uses the smallest shape that genuinely
forces an insertion (`SET x = 1` before `END;`), and the lesson — a green test
run is only as real as the grammar copy it loaded — is recorded in the test
comment and this log.

**Analyzer/highlights follow-through:** a datatype-less `DECLARE` (namespace
alias) is not indexed as a variable; `function_call` names may be keyword tokens
(`SUBSTRING(s, 2, 1)`); clause-function nodes push the same routine reference a
comma call would; `highlights.scm` captures the new call shapes. A dedicated
`NAME`-alias grammar branch was built, measured and **removed**: it made DECLARE
LR-ambiguous, and declaring the conflict merged states and flipped tree-sitter's
missing-`;` recovery from insert-marker to swallow-next-statement — the alias
already parses as NAME-typed-plus-initial, so the parser keeps no ambiguity and
the analyzer keeps the distinction.

**Verified:** `npm test` 119/119 (after `npm ci`, so the grammar copy is the
fresh one); `ESQL_LSP_NO_GRAMMAR=1 npm test` 94 pass / 25 skip / 0 fail;
`npm run grammar:test` 85/85; `npx tree-sitter generate` exits clean with **no**
LR conflicts; `smoke:stdio --expect-grammar` PASS; `grammar-scan.js` over the
corpus: 27 damaged → **1** (the J file); `corpus-probe.js` re-run: grammar-mode
findings 63 → **8** across **5** files, heuristic 7 → 7, protocol violations **0**
in both modes, 103/103 documents publishing.
