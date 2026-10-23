# AGENTS.md

ESQL (IBM ACE/IIB) language server in TypeScript, plus a tree-sitter grammar for
the same language. Two npm packages in one repo: the repo root is the LSP server,
`tree-sitter-esql/` is a standalone grammar package consumed as a `file:`
**dev**Dependency. Crucial detail: npm installs that dep as a *snapshot copy* in
`node_modules/tree-sitter-esql/`, and the server plus the root tests load the
native addon from **that copy** — not from `tree-sitter-esql/`.

## Commands

- `npm run build` — `tsc -p ./` (tsconfig has `rootDir: "."`, `module: commonjs`), so
  `src/` **and** `test/` compile to `dist/`. Tests are plain `dist/test/*.js`;
  there is no TS-aware runner, and `bin/esql-lsp.js` only requires `dist/src/server.js`.
- `npm test` — build, then `node --test dist/test/*.test.js` (the glob is expanded
  by the shell; new `*.test.ts` files are picked up automatically).
  - One file: `npm run build && node --test dist/test/symbols.test.js`
  - One case: `node --test --test-name-pattern 'missing END MODULE' dist/test/diagnostics.test.js`
- `ESQL_LSP_NO_GRAMMAR=1 npm test` — same suite with grammar mode forced off:
  grammar-only cases must **skip**, everything else must pass, zero failures.
  That is the mode users without a C toolchain get.
- `npm run grammar:test` — the grammar corpus suite. Single case:
  `cd tree-sitter-esql && npx tree-sitter test -i '<name regex>'`.
  `npx tree-sitter test -u` rewrites the expected s-expression trees in the corpus
  files — use it only after a deliberate, reference-checked grammar change.
- `cd tree-sitter-esql && npx tree-sitter parse path/to/file.esql` — the fastest way
  to see what the grammar makes of a snippet: prints the annotated tree and exits
  **1 if any `ERROR` node** is present, 0 when clean (works from the grammar
  directory despite the "no parser directories" config warning).
- `npm run smoke:stdio` — starts the built server and asserts it answers;
  `--expect-heuristic` / `--expect-grammar` pin which mode must be active.
- `npm run verify:package` — packs, installs the tarball twice (without and with
  lifecycle scripts) and drives both installed servers. Needs `tar`; ~2 npm installs.

There is **no linter or formatter** configured (no eslint/prettier/biome config or
devDependency). The `eslint-disable-next-line` comments in `src/parser.ts` are
decorative — do not add eslint just to satisfy them.

## The grammar-copy trap (biggest time sink in this repo)

After editing `grammar.js`: `cd tree-sitter-esql && npx tree-sitter generate`
regenerates the *committed* `src/parser.c`, `src/node-types.json`,
`src/grammar.json`, but the copy in `node_modules/tree-sitter-esql/` keeps the old
parser **and** its own `build/*.node`. Verified on npm 9: neither `npm rebuild`
(in either directory) nor a plain `npm install` re-copies the changed `file:` dep.
**`npm ci` at the repo root is the reliable refresh** (it re-copies the sources and
runs the grammar's `install` → `node-gyp-build`, ~5 s here). Symptom of skipping
this: corpus tests pass against the new grammar while the server and root tests
still parse with the stale one.

Never hand-edit `parser.c` / `node-types.json` / `grammar.json` — regenerate.

## Silent-degradation traps

- `analyzeDocument()` in `src/parser.ts` mines specific grammar node types
  (declared names + scope, SET targets, modules, routines, schemas, references,
  ERROR/inserted-token regions). Renaming a node type breaks extraction silently.
- Corpus files embed full s-expression trees, and the runtime reads
  `tree-sitter-esql/queries/highlights.scm` at startup for semantic tokens. A node
  type that no longer exists makes `new Query()` throw (`TSQueryErrorNodeType`),
  `doInit()` catches it, and **all** grammar features go dark with one stderr line.
  Confirm with `npm run smoke:stdio -- --expect-grammar`.
- The grammar's package is `"type": "module"` with a top-level-await binding, and
  the server compiles to CommonJS — so a literal `import()` in `parser.ts` becomes
  `require()` and fails. Keep the `new Function('s', 'return import(s)')` trick.
- `initGrammar()` is async and non-blocking: the server answers requests
  immediately and re-validates open documents once the grammar lands. Don't write
  tests that assume the tree is ready on the first request.

## Architecture pins

- Protocol wiring lives only in `src/server.ts`; analysis in the feature modules
  (`diagnostics.ts`, `completion.ts`, `hover.ts`, `symbols.ts`, `definitions.ts`);
  ESQL reference data in `src/data/`. `parser.ts` is the only tree-sitter consumer
  and must degrade to the Phase 1 heuristics (`scanner.ts` + regex checks).
- Every grammar-backed feature needs a heuristic fallback **and a test for it**.
  Tests asserting *fallback* behaviour must not skip when the addon is missing —
  only grammar-only expectations skip, via `skipWithoutGrammar()` in
  `test/grammarStatus.ts`.
- Symbols, hover, completion and definitions share one pattern extractor,
  `declarationsFromSource()` in `src/definitions.ts`; the tree path is
  `analyzeDocument()`. Fix a quirk (e.g. multi-name `DECLARE a, b, c`) in one place,
  or the four features disagree. `test/symbols.test.ts` compares both outlines.
- Unclosed module (the normal state of a buffer being typed): the fallback lets a
  module without `END MODULE` own everything to EOF; the tree path rebuilds the
  header from the ERROR region (`damagedModuleInfo()`). Keep the two paths in agreement.
- Every diagnostic is switchable via `initializationOptions` /
  `didChangeConfiguration`; a new check needs a unit test + an e2e assertion over a
  real stdio session + a settings-toggle case (`test/e2e.test.ts`).
- e2e fixtures are line-number-coupled to request positions — edit fixture text
  carefully and re-verify positions.

## Grammar is a permissive superset

The grammar follows the IBM ACE 12.0.x railroad diagrams and deliberately accepts
underspecified forms; strictness belongs in the analyzer. When a fixture disagrees
with `grammar.js`, decide deliberately which is wrong and record the reasoning.
Rejected-but-real-looking ESQL is catalogued in
`tree-sitter-esql/VERIFICATION.md` ("Unadjudicated construct gaps") — do not
loosen the grammar for one of those without reading the diagram for it. Every
new/changed construct gets a corpus test (`test/corpus/*.txt`, two-`===` name
format, CLI 0.27). LR conflicts during `generate` are the hard part; document
rule-level conflict tricks in grammar comments.

## Packaging

The grammar is not on npm, so a published tarball must carry it: `prepack`
(`scripts/prepack-grammar.js`) vendors the grammar *sources* into git-ignored
`vendor/tree-sitter-esql/`, `postinstall` (`scripts/build-grammar.js`) best-effort
compiles the addon and must **never** fail an install, and `locateGrammar()` in
`parser.ts` resolves package-or-vendored. npm strips `devDependencies` at publish,
which is how the `file:` entry disappears for registry users.

Do not replace this with `bundleDependencies`: npm bundles the *installed* grammar
folder, `build/*.node` included, which ships the release machine's binary to every
other platform and silently degrades everyone to heuristic mode. Run
`npm run verify:package` before tagging — note that it (and `npm pack`) leave the
generated `vendor/` sitting in the checkout; it is git-ignored, do not commit it.

## Commits and release

- History is a one-line subject plus a body saying what was actually verified
  (which suites, which counts) — match that, and disclose AI assistance, which
  CONTRIBUTING makes a ground rule ("green tests written by the same tool are a
  starting point, not proof").
- Every commit uses one identity, `nils <nige@users.noreply.github.com>`, and this
  machine has no *global* git identity: on a fresh clone or worktree set the
  repo-local `user.name`/`user.email` before the first commit instead of guessing.
- CI has no publish/deploy job. Publishing is manual `npm publish` after
  `npm run verify:package`; the version that matters lives in the root
  `package.json` (the grammar package versions itself independently).

## Verification

- Locally "green" = `npm test` **and** `npm run grammar:test`; add
  `ESQL_LSP_NO_GRAMMAR=1 npm test` when touching degradation and
  `npm run verify:package` when touching packaging.
- CI (`.github/workflows/ci.yml`) runs the grammar job (regenerate + `git diff`
  guard on `tree-sitter-esql/src` + corpus), the root suite on Node 18/20/22
  asserting `# skipped 0` (proves the tree path really ran), a no-toolchain job
  (`npm ci --ignore-scripts`, asserts cases really do skip), and the
  install-from-tarball job. Those skip assertions are the point of the jobs — fix
  the change, not the assertion.
