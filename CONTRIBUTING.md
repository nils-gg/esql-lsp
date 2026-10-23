# Contributing

Thanks for keeping your hands on the code! This guide is short and
opinionated; the README's
[vibe-coded disclosure](README.md#vibe-coded-disclosure) explains the
project's unusual provenance — it is relevant to how contributions should
be made, so give it a read.

## Dev setup

Requirements: Node.js ≥ 18, npm, and a C toolchain (cc, python3, make) for
the tree-sitter native addon.

```sh
npm install               # also builds the grammar native addon
npm run build             # TypeScript -> dist/
npm test                  # 83 tests: unit + real stdio LSP sessions
ESQL_LSP_NO_GRAMMAR=1 npm test  # same suite, grammar switched off: cases skip, none may fail

cd tree-sitter-esql
npm install               # grammar's own deps (tree-sitter CLI)
npx tree-sitter test      # 71 corpus tests (or `npm run grammar:test` from the root)
```

A C toolchain is recommended but not required for contributing: without one the
native addon simply does not build, and the suite runs in heuristic mode — which
is a supported product surface, not a broken setup.

## The two ground rules

1. **The grammar is the ground truth for syntax.** When a test fixture
   disagrees with `tree-sitter-esql/grammar.js`, decide *deliberately*
   which one is wrong and record the reasoning (test name, comment, or
   VERIFICATION.md) — do not silently bend whichever is easier. The
   grammar follows a **permissive-superset** philosophy: it accepts
   everything the IBM ACE 12.0.x railroad diagrams accept, plus
   constructs the diagrams underspecify (terminator placement, clause
   order). Strictness belongs in the analyzer layer, not in the grammar.
2. **The server must degrade gracefully.** Everything grammar-backed
   (`src/parser.ts` and its callers) has to keep the server fully alive —
   on the Phase 1 heuristics — when the native addon fails to build or
   load. New tree-based features need a fallback path and a test for it.
   Tests that assert *fallback* behaviour must keep running when the addon
   is missing (only grammar-only expectations skip — see
   `skipWithoutGrammar()` in `test/grammarStatus.ts`), because heuristic
   mode is what users without a C toolchain actually get.

## Working on the grammar

- Edit `grammar.js`, then `npx tree-sitter generate && npx tree-sitter test`.
- `src/parser.c`, `src/node-types.json` and `src/grammar.json` are
  **committed generated output** — regenerate them, never hand-edit.
- Every new/changed construct gets a corpus test in `test/corpus/`
  (two-`===` name format, CLI 0.27). Conflicts during `generate` are the
  hard part of this grammar; document rule-level tricks in comments —
  several rules exist solely to resolve one.
- Grammar semantics consumed by the LSP live in `src/parser.ts`'s
  `analyzeDocument()` walk (declared names, SET targets, ERROR/inserted
  -token regions). Changing node types can silently break those
  extractions — run the root test suite after grammar changes.

## Working on the server

- All protocol wiring in `src/server.ts`; analysis in the feature modules
  (`diagnostics.ts`, `completion.ts`, `hover.ts`, `symbols.ts`,
  `definitions.ts`). ESQL reference data lives in `src/data/`.
- Symbols, hover, completion and definitions all read declarations through the
  same extractor — `declarationsFromSource()` in `src/definitions.ts` for the
  pattern path, `analyzeDocument()` in `src/parser.ts` for the tree path. Fix a
  quirk (say, multi-name `DECLARE a, b, c`) in one place, or the four features
  start disagreeing; `test/symbols.test.ts` compares the two outlines directly.
- Check your change in both modes: `npm test` and
  `ESQL_LSP_NO_GRAMMAR=1 npm test`.
- New diagnostics: a unit test in `test/` **and** an e2e assertion over a
  real stdio session (`test/e2e.test.ts`), including a settings-toggle
  case (every check is switchable via `initializationOptions` /
  `didChangeConfiguration`).
- Line-number-sensitive fixtures in e2e are coupled to request positions —
  when you edit fixture text, re-verify those positions.

## Packaging and releases

The grammar is not on the npm registry, so the published tarball has to carry it:

- `prepack` first runs `npm run build`: `npm pack` compiles nothing, and a tarball
  packed from a clean clone would contain no `dist/`, so it would install and then
  fail to start (`bin/esql-lsp.js` only requires `dist/src/server.js`). It then runs
  `scripts/prepack-grammar.js`, which vendors the grammar's published file list into
  `vendor/tree-sitter-esql/` (generated, git-ignored). The compiled addon is
  deliberately **not** vendored.
- `postinstall` runs `scripts/build-grammar.js`, which best-effort-compiles that
  vendored copy and never fails the install — no toolchain means heuristic mode,
  which is exactly the tested degradation path.
- `parser.ts` resolves the grammar either from the installed package (development)
  or from `vendor/` (an installed tarball).
- Do not replace this with `bundleDependencies`: npm bundles the *installed*
  grammar folder, `build/*.node` included, which would ship a binary built for
  the release machine to every other platform.

Before tagging a release: `npm run verify:package` (packs, installs the tarball
twice — without scripts and with — and drives the installed server in each).

## Pull requests

- One concern per PR; small focused commits; explain what and why.
- Tests green both suites (`npm test`, `npm run grammar:test`) before review.
- CI (`.github/workflows/ci.yml`) runs the grammar suite (with a check that the
  committed `src/parser.c` really matches `grammar.js`), the root suite on
  Node 18/20/22, a no-toolchain job, and the install-from-tarball packaging
  check. The jobs *assert* that grammar-backed tests run where a toolchain
  exists and skip where it does not — if one of those assertions fails, the
  change (not the assertion) is what needs fixing.
- AI-assisted contributions are explicitly welcome — this repo itself is
  vibe-coded. Please **disclose** AI assistance, and treat green tests
  written by the same tool as a starting point, not proof: say which
  parts you actually verified.

## Reporting issues

Include: the `.esql` snippet (minimal reproducible example), the client
and version, and — where behavior differs — what the **ACE compiler**
says; IBM's compiler is the authority, and "LSP silent, compiler errors"
(or the reverse) is exactly the kind of bug worth filing. A Neovim
`:LspLog` excerpt (at info level) helps a lot.

Security: please use GitHub's *private vulnerability reporting* rather
than a public issue.
