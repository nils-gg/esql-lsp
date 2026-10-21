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
npm test                  # 50 tests: unit + real stdio LSP sessions

cd tree-sitter-esql
npm install               # grammar's own deps (tree-sitter CLI)
npx tree-sitter test      # 71 corpus tests
```

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

- All protocol wiring in `src/server.ts`; analysis in the feature modules.
- New diagnostics: a unit test in `test/` **and** an e2e assertion over a
  real stdio session (`test/e2e.test.ts`), including a settings-toggle
  case (every check is switchable via `initializationOptions` /
  `didChangeConfiguration`).
- Line-number-sensitive fixtures in e2e are coupled to request positions —
  when you edit fixture text, re-verify those positions.

## Pull requests

- One concern per PR; small focused commits; explain what and why.
- Tests green both suites (`npm test`, `tree-sitter test`) before review.
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
