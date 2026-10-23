# ISSUES.md — findings from testing the LSP against real-world ESQL

Tested 2026-10-23 against 103 `.esql` files from the 11 repositories listed at the
bottom. Every item below was reproduced twice: once on the real file, once on the
minimal snippet printed inline (so this document stands on its own — the corpus
and the probe scripts lived in `/tmp` and are gone).

**Grammar items are recorded, not fixed.** Per `AGENTS.md` /
`tree-sitter-esql/VERIFICATION.md`, the IBM ACE 12.0.x railroad diagram — not
real-world usage — adjudicates whether the grammar or the sample is wrong. Real
code is frequency evidence, nothing more. Items marked *[clear bug]* are not a
reference question and can be fixed directly.

Severity: **Critical** = the feature silently does not work · **High** = wrong
result on ordinary code · **Medium** = noise / missing feature on real code ·
**Low** = polish.

---

## Status after this round of fixes (2026-10-23)

Ten of the thirteen are fixed; I-3 is the grammar work this document exists to
queue up, and I-6 / I-13 each need a decision. Measurement is the same corpus,
same serial probe (one document at a time — see I-1), both modes.

| item | status | what proves it |
|---|---|---|
| I-1 | **fixed** | per-URI `Map<uri, Timeout>`; new e2e case opens three broken files in one burst and asserts all three publish (restoring the old single timer makes that case time out) |
| I-2 | **fixed** | `comment: /\/\*(?:[^*]|\*+[^*/])*\*+\//` + `test/corpus/comments.txt`; corpus scan: files where a comment swallowed code 1 → **0**, hidden lines 151 → **0** |
| I-3 | open (by design) | families A–J untouched, each awaiting its railroad diagram; their messages are readable now (I-12). The I-2 fix uncovered two more constructs — logged as family K |
| I-4 | **fixed** | `nameRange()` adds `match.index`; heuristic symbols whose `selectionRange` did not hold their own name 168/344 → **0/344**, and after the fix all 670 (grammar) / 674 (heuristic) symbols are exact |
| I-5 | **fixed** | `paramSegments()` / `locatedRoutineParams()` read a header across lines; `symbols.ts` now consumes `routinesFromSource()`; definition + references asserted on a split header in **both** modes |
| I-6 | open | still needs the two paths reconciled inside a damaged region |
| I-7 | **fixed** | one hint per routine, none when the scope never mentions `Properties`; corpus 51 hints → **0**; unit + stdio e2e + settings-toggle cases |
| I-8 | **fixed** | `XMLNS_RE` needs a following `.` and rejects `XMLNSC`; both `NamespaceDecl` spellings are now negative tests; corpus 2 → **0** |
| I-9 | **fixed** | whole-file `(`/`[` depth, `SELECT` as a continuation word, operator at the start of the next line; range spans the statement; corpus 13 hints → **0**, genuine misses still flagged |
| I-10 | **fixed** | quoted declares read from the raw line (range = the name, quotes excluded) and `wordAtPosition()` resolves quoted names for hover/definition/references; ghost `EXTERNAL` symbols 4 → **0**. The four real quoted names now exist — in heuristic mode (674 symbols vs grammar's 670), so the outline divergence that is left in those 4 files is I-3/H, not a fallback bug |
| I-11 | **fixed** | hover for a module (kind + contained routines), hover/definition/references for `BROKER SCHEMA` with dotted-segment matching. Measured in **both** modes: Module hover 0/117 → **117/117**, Namespace hover/definition/references 0/50 → **50/50**, and every one of the 670 (grammar) / 674 (heuristic) symbols answers definition, references and hover at its own advertised position |
| I-12 | partially fixed | no more token names in messages (`expected a data type here`, `expected a field reference here`); the multi-line `Syntax error.` span quality is still open |
| I-13 | open | needs the workspace-index decision (see the note at the end) |

Corpus effect on findings, 103 files, both modes:

| mode | files with findings | findings | what is left |
|---|---|---|---|
| grammar | 41 → 29 | 111 → 63 | 56 grammar gaps (I-3 families), 4 `FailureCount` (I-13), 3 × `Main() contains neither RETURN nor PROPAGATE` |
| heuristic | 26 → 4 | 73 → 7 | the same 4 + 3 |

Those 7 were each read back and are **true positives**: `FailureCount` is I-13,
and the three `Main()`s really do fall off the end (`TransformExceptionHandler`,
`Sender`'s `InitNoSequenceRetry` module, `MQGetDemo_MF_RemoveMQHeaders`). The
heuristic path no longer warns about anything valid on this corpus.

One honest regression to record: `npx tree-sitter parse` now reports **27** files
with ERROR/MISSING where it reported 26. The comment fix did not break anything —
it made `Routing_using_memory_cache.esql`'s 151 lines visible for the first time,
and that code uses constructs the grammar does not have (family K). A file that
parses "clean" because its body was mistaken for a comment is not a clean file.

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

Corpus character: 83 ASCII + 3 UTF-8 with non-ASCII (one with CJK in a comment),
0 CRLF (CRLF covered by a synthetic case), largest file 205 lines.
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

**Open** — deliberately. Nothing below is adjudicated yet; read the diagram, then change the rule, then `npx tree-sitter generate && npm ci`. What did change is the *messages* (I-12), so each of these now says what it wanted.

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

**Open.** Left as reported. The tree path rebuilds the module header from the ERROR region but does not descend for names, so the outline and the undeclared-variable check go quiet inside a damaged region. Fixing it means deciding whether the tree path or the pattern path is authoritative *inside* an ERROR node — `test/symbols.test.ts` already has the comparison harness to hold them together once that is settled.

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

## Not issues (checked, behaving as designed)

* **No crashes, ever.** 103 files × both modes: 0 timeouts, 0 unanswered requests,
  0 malformed frames, 0 server stderr errors, clean `shutdown`/`exit`.
* **No bad ranges.** 0 out-of-bounds ranges and 0 definition-text mismatches over
  every diagnostic, symbol, definition and reference returned; the UTF-8 files and
  a synthetic CRLF file show no offset drift.
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
* Heuristic mode emits 0 semantic tokens: expected — tokens are produced from the
  grammar's `queries/highlights.scm`, so without the addon there is no source for
  them. The capability is advertised unconditionally (see the comment at
  `src/server.ts:131`), so a client will keep asking and get an empty result
  in that mode. That is the documented degradation, not a bug.
* True positives that kept working and should not be "fixed": missing `END MODULE`,
  `Main() body is not closed with END;`, `Main() contains neither RETURN nor
  PROPAGATE.` (correct — `Sender.esql`, module `InitNoSequenceRetry`, really falls
  off the end), undeclared variable in `SET` on a clean file.

## Suggested order of work

I-1 (nothing else can be trusted until every document reports) → I-4 and I-5
(cheap, restore the sold no-toolchain surface) → I-2 (silent, one-line regex) →
I-9, I-7, I-8 (heuristic/analyzer noise) → I-6 (parity) → I-11, I-12 (features,
messages) → I-3 families, each after its railroad diagram is read, starting with
A/F/B (highest real-world frequency) → I-13 (needs a design decision).

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
