# ACE Compiler Differential — grammar vs. the real ESQL compiler

Round: 2026-10-29 (list.md issue 8, enhancements 28–29). The grammar had so
far been verified against the IBM ACE 12.0.x railroad *documentation*
(`VERIFICATION.md`). This round runs the grammar against the *compiler
itself*: an IBM ACE Toolkit installation was provided, its headless ESQL
builder was driven over a probe corpus, and every disagreement between the
compiler and `tree-sitter parse` was adjudicated.

## Environment — and the version caveat

* `/opt/ibm/ace-13.0.9.0` — **ACE 13.0.9.0 EVALUATION**. The grammar targets
  **12.0.x**, so the compiler is ground truth for *what real ACE accepts*,
  not a transcription of the 12.0.x diagrams. Every disagreement therefore
  lands in one of three buckets, recorded per probe:

  * **deliberate permissiveness** — the grammar accepts a form the 12.0.x
    railroad shows (or that legacy corpora prove real) and 13 tightened or
    removed: `VARCHAR`/`NAMEVALUE`/`LOGICAL` datatypes (removed in 13 —
    ACE 12 compiled them), legacy handler conditions (`LIKE`/`VALUE`/`ESCAPE`),
    `BIT`/`CHAR` typed literals, `INSERT … WHERE`, `REFERENCE TO`/`DECIMAL(p,s)`
    parameters, optional `;` terminators where the diagram shows them optional.
  * **12-vs-13 drift** — same shape, verdict changed between releases.
  * **grammar bug** — the compiler accepts and the grammar *couldn't parse*:
    only two were found, both fixed (below).

* `esqllangbuilder` (`com.ibm.etools.mft.esql.lang.esqllangbuilder`) checks
  **syntax and routine signatures only**; it does not resolve variables.
  Probes may reference undeclared names (`SET OutputRoot…`, `SET x = 1` with
  no DECLARE) and still compile — which is exactly what makes them probes
  rather than programs. Semantic complaints do occur (`Incorrect schema name
  "mft.S2"`) and are read as *parse-accepted*.

* mqsicreatebar's error markers are a grammar oracle on top of a verdict: the
  hint lists every valid follow-token — `Valid options include: DAY HOUR
  MINUTE MONTH SECOND YEAR.` settled the plural-interval-qualifier question
  (singular only) where the 12.0.x diagram page could not be reached.

## How the harness works (`scripts/ace-differential/`)

* `make-probes.sh` regenerates `probes/*.esql` (55 fixtures: 29 forms the
  compiler accepts, 26 forms it rejects; the `ok_`/`no_` prefix names the
  *compiler* verdict, not ours).
* `manifest.json` pins BOTH expected verdicts plus a `class` and a note per
  probe. It is the adjudication ledger for this round; changing a row means
  re-reading the 12.0.x diagram for that construct (ground rule), and
  changing the grammar means re-verifying against the compiler.
* `run.js` assembles a throwaway Toolkit workspace (`mkdtemp`), a message-set
  project (`com.ibm.etools.msg.validation.msetnature` + the
  `esqllangbuilder` builder), copies the probes in and runs

  ```sh
  . $ACE_HOME/server/bin/mqsiprofile
  mqsicreatebar -data <fresh-ws> -p PROBES -compileOnly -trace -v <log>
  ```

  Per-file verdicts come from `Problem N: Resource - /PROBES/x.esql; Error
  message - …` markers; the same files are parsed with the tree-sitter addon
  from `node_modules` (ERROR/MISSING ⇒ reject); both are compared to the
  manifest. **A stale `.metadata` replays old markers and poisons verdicts —
  the runner always starts from a fresh workspace.**
* Without an ACE install or without `DISPLAY` (the workbench needs a display,
  `BIP0965E` otherwise) the ACE side **skips with exit 0** and the
  tree-sitter side is still checked against the manifest — the same
  degradation discipline as the grammar-mode tests.

```sh
npm run verify:ace                        # needs ACE + DISPLAY (e.g. Xvfb)
node scripts/ace-differential/run.js --ts-only
node scripts/ace-differential/run.js --ace-dir /path/to/ace --keep-ws
```

Result 2026-10-29: **55/55 probes match the manifest** — ACE compiles the 29
`ok_` probes, tree-sitter parses 52/55 (the 3 rejects are the manifest's
`match-reject` rows: `VALUE 42` handler condition, bare `CREATE MODULE`,
plural `INTERVAL '5' DAYS`).

## What the differential changed

1. **Handler condition list — grammar bug fixed.** The canonical multi-condition
   form `DECLARE … HANDLER FOR SQLSTATE '38522', SQLSTATE '38523'` did not
   parse: the old rule attached the `SQLSTATE` keyword once (`FOR SQLSTATE v, v`).
   Each condition now carries its own optional keyword (`sqlstate_value`), and
   the shorthand survives. Compiler: `ok_handler_two_sqlstate`.
   Corpus: "handler with multiple SQLSTATE conditions".
2. **Bare `DECLARE iv INTERVAL;` — grammar loosened.** The qualifier is
   mandatory in the datatype per the diagram pages, but the compiler compiles
   the qualifier-less form, so `datatype` now makes `_interval_qualifier`
   optional (the *literal* `INTERVAL 'x' <qualifier>` keeps it mandatory —
   that is what was verified). Corpus: "bare INTERVAL datatype without
   qualifier". Compiler: `ok_set_interval_literal`.
3. **A misreading corrected by the runner itself.** An earlier scratch probe
   round suggested `LOG USER TRACE VALUES ('m');` was compiler-rejected; the
   shipped harness showed ACE 13 **accepts** it — what it rejects is `FULL`
   without `EXCEPTION` (`Valid options include: EXCEPTION.`). The probe pair
   `ok_log_user_trace_values` / `no_log_ut_full_values` encodes the verified
   split. The issue-9 fix (`LOG …;` with VALUES optional) is compiler-confirmed
   by the bare and VALUES-carrying forms both compiling.
4. **Both remaining issue-9 open items closed by the oracle:** bare
   `CREATE MODULE` is *not* ESQL (the compiler demands `COMPUTE`/`DATABASE`/…
   after `CREATE`), and plural interval qualifiers (`DAYS`) are singular-only
   (`DAY HOUR MINUTE MONTH SECOND YEAR`). Both agree with what the grammar
   already does — `no_bare_create_module`, `no_interval_plural` now pin them.

## Findings kept as-is (permissiveness ledger)

| Family | Compiler (13.0.9) | Grammar | Why this side wins |
|---|---|---|---|
| `END;` / `END MODULE;` terminators | required (`;` hints) | optional | the 12.0.x diagrams show both as optional, and an unterminated module is the normal state of a buffer being typed |
| `;` after a module header | rejected | accepted-optional | same header diagram |
| `VARCHAR` / `NAMEVALUE` / `LOGICAL` | rejected (removed in 13) | accepted | pre-ACE legacy families ACE 12 compiles; `deprecated-type` hint carries strictness (E-2/E-3 adjudications) |
| `SQLSTATE LIKE 'p' ESCAPE 'e'`, `VALUE` conditions | rejected (`SQLSTATE` only) | accepted | 11.x/12.x pages document them; legacy files carry them |
| `BIT '…'` / `CHAR 'a'` literals | rejected | accepted | on the 12.0.x expression page |
| `INSERT … WHERE` | rejected (`;` hint) | accepted | on the 12.0.x INSERT railroad |
| `REFERENCE TO <tree>` / `DECIMAL(p,s)` parameters | signature error | accepted | 12.0.x signature diagram shows both; 13 tightened signatures |
| leading-dot `BROKER SCHEMA .mft.X` | schema-decl syntax error | accepted | legacy path form; plain names parse and fail semantically |
| `LOG … FULL` without `EXCEPTION` | rejected (`EXCEPTION` hint) | accepted | the LOG diagram lists the clauses independently |

## Analyzer-candidate hints (compiler-rejects the grammar models permissively)

Deliberately NOT grammar changes — these are strictness the LSP analyzer could
carry later (each has a probe pinning the compiler verdict):

* `DECLARE … SHARED` inside a routine — "Statements are not allowed in
  function or procedure scope" (SHARED is module-level).
* `SET <path> TYPE|NAMESPACE|NAME <value>` without `=` — hint is literally
  `=` (family G2).
* `MOVE <rooted-path> TO …` — the source must be a declared variable / `THE`
  expression.
* `DECLARE <scalar> NAMESPACE|NAME '…'` — those clauses belong to the
  alias declares (`DECLARE p NAMESPACE 'uri';`), not to scalar datatypes.
* `SELECT ITEM SUM(…)` — `SUM`/`MAX`/`MIN` are not SELECT builtins ("Incorrect
  function or procedure name"); `COUNT` is.

## The 87-case corpus sweep

Before designing the probes, the whole tree-sitter corpus (87 cases, split per
case) went through the same pipeline — after normalizing only what the
compiler demands as *mandatory* (routine-body `END;`, `END MODULE;`; a `;`
after a module header is invalid and was never added). **55/87 compiled on
ACE 13**; every one of the 32 rejects was triaged: harness-context artifacts
(BROKER SCHEMA statements need a broker-schema project, `MOVE`/terminal forms
need flow-project context, stale-marker pollution in early rounds) vs. the
permissive families above. The sweep is exploratory history; the 55 checked-in
probes are its distilled, rerunnable form — the corpus itself is
line-number-coupled to the server tests and stays untouched by it.
