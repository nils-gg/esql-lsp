# Corpus probes

These are the measurement scripts behind the numbers in `ISSUES.md`. They are
archived so the findings are reproducible rather than anecdotal — every "fixed,
verified" claim in the issue log was produced by one of them.

They are **not** part of `npm test` and not run by CI. The unit/e2e suites in
`test/` are the contract; these are the instruments that measured the real-world
behind it.

## The corpus

Every corpus probe needs a directory tree of real `.esql` files:

```
node scripts/probe/corpus-probe.js --corpus=/path/to/esql/files
node scripts/probe/grammar-scan.js --corpus /path/to/esql/files   # both arg forms work
ESQL_CORPUS=/path/to/esql/files node scripts/probe/grammar-scan.js
```

Without a corpus they exit 2 and say so. The corpus the ISSUES.md numbers came
from is **103 `.esql` files from 11 public ACE/IIB repositories** (tool-iib demo
apps, an IBM Healthcare starter, Paymob/MQTT/JSON-Transform integration apps and
similar) gathered into one tree for review. It is not committed: it is other
people's code, and licensing for redistribution was not the task. Any tree of
real ESQL works, but the specific counts in ISSUES.md ("26 of 103", "0/339
out-of-scope offers", …) belong to that one corpus.

A flag that is silently not read is a result that is not real: the archived
first edition of these probes read only `--corpus=<dir>` and ignored
`--corpus <dir>`, which made a run fall back to scanning the probe's own
directory — 123 files of pure phantom findings. The probes now accept both
forms, reject unknown flags, and every one prints its `files:` count; check it
before believing anything downstream.

## What each probe does

| script | measures | was written for |
|---|---|---|
| `corpus-probe.js` | protocol invariants over the whole corpus: every open doc publishes diagnostics, ranges in-bounds and non-overlapping, symbol trees nested, references monotonic, semantic-token stream legal, incremental edit moves the analysis and restore returns the baseline. `--mode heuristic` runs the fallback path. | I-1, I-2, I-3, I-6, I-9, I-14… round-2 sweep |
| `grammar-scan.js` | raw tree-sitter pass: which files have `ERROR`/`MISSING` nodes and what text they cover. Exit code is the CLI's, not the probe's. | I-3 (the 26-of-103 table) |
| `scope-hover.js` | for every name declared in ≥2 scopes, does hover/definition resolve to the declaration actually in scope? | I-15, I-16 |
| `scope-completion.js` | server-driven completion check: any offered `Declared:` item whose own scope excludes the cursor is a violation. Needs a built `dist/`. | I-16 |
| `line-endings.js` | a client transcript for CRLF and CR-only files: diagnostic ranges, symbol ranges, completion after a completion-trigger edit. | I-21 |
| `cache-latency.js` | request latency with one document open vs. several (the old single-entry parse cache). | I-19 |
| `malformed-requests.js` | protocol robustness battery: pre-initialize requests, unknown methods, wrong-shaped params, cancels, double didOpen, partial settings. Server must answer errors, never hang or die. | I-14, I-22 |

All of them drive the BUILT server (`bin/esql-lsp.js` / `dist/`), so run
`npm run build` first. `grammar-scan.js` loads the grammar addon from
`node_modules/tree-sitter-esql/` — the copy the server uses, which is why the
grammar-copy trap in `AGENTS.md` matters for reading its output honestly.

## npm aliases

`npm run probe:corpus -- --corpus=<dir>` and friends — see the `probe:*`
entries in the root `package.json`.
