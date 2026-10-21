# esql-lsp

> ⚠️ **Vibe-coded software.** This project — code, grammar, tests and docs —
> was written almost entirely through AI-assisted coding sessions. It works
> (it has the test suite to prove it), but no human has audited every line.
> Use it, share it — and review it like any code you did not write yourself.
> Details: [Vibe-coded disclosure](#vibe-coded-disclosure).

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
server for **ESQL** — the transformation language of IBM App Connect
Enterprise (ACE) / Integration Bus (IIB).

Works with any LSP client; first-class configs are included for **Neovim**
and **OpenCode**.

> Phase 1: static analysis, completion, hover and document symbols —
> pattern-based on a comment/string-aware scanner.
> Phase 2 (landed): the **tree-sitter grammar** in
> [`tree-sitter-esql/`](tree-sitter-esql/) is integrated into the server —
> grammar-backed syntax errors, exact declared-variable analysis and
> semantic-token highlighting, with automatic fallback to heuristics when
> the native grammar cannot load (see [Roadmap](#roadmap)).

## Features

### Diagnostics

| Check | Severity | Description |
|---|---|---|
| Syntax error / missing token | 🔴 Error | tree-sitter `ERROR` nodes plus recovered-but-inserted tokens (a missing `;` the parser silently repaired) — when the grammar is loaded |
| Missing `END MODULE` | 🔴 Error | Module never closed |
| Module without `Main()` | ⚠️ Warning | ACE cannot execute the module |
| `Main()` without `RETURN`/`PROPAGATE` | ⚠️ Warning | Message will not reach any terminal |
| Variable in `SET` without `DECLARE` | ⚠️ Warning | Grammar-exact when loaded; case-insensitive regex otherwise; function params count as declared |
| Deprecated `XMLNS` parser | ⚠️ Warning | Use `XMLNSC` in ACE 12 |
| Missing `;` at end of statement | 💡 Hint | Heuristic on statement starters (skipped when the grammar is loaded — real missing `;` become syntax errors then) |
| `OutputRoot.JSON.Data` set without Properties copy | 💡 Hint | Very common integration bug |

All checks run on a masked view of the source where comments and string
literals are blanked, so `'END MODULE'` inside a string cannot fake a module
boundary. With the grammar loaded, undeclared-variable analysis and syntax
errors come from the parse tree (exact ranges, multi-line aware); intact
statements inside a broken region are still analysed.

### Completion

- ~70 built-in ESQL functions with signature + markdown documentation
- Keywords, data types, message tree variables (`InputRoot`, `Environment`, …)
- Context-sensitive: parser domains after `InputRoot.`/`OutputRoot.`,
  `Data` after `.JSON.`, common `LocalEnvironment` fields, types after
  `DECLARE <name>` / `RETURNS`
- Variables declared in the current document
- 43 snippets (module skeletons, IF/CASE/WHILE, THROW, PASSTHRU, JSON
  responses, …) — triggered like `module-compute`, `throw`, `trycatch`
- Filtered by the word you are typing

### Hover

Markdown documentation for built-in functions, message tree variables,
parser domains and data types.

### Document symbols

`BROKER SCHEMA` namespace, modules, functions/procedures (with params, body
range) and declared variables — nested under their module for outline
views and folding.

## Requirements

- Node.js >= 18 (server runtime)
- TypeScript toolchain only for building
- **Optional (recommended):** a C toolchain (cc/python/make) so
  `npm install` can build the tree-sitter native addon. Without it the
  server still runs — with the Phase 1 heuristics only (no grammar syntax
  errors or semantic tokens); it logs which mode is active at startup.

## Build

```sh
npm install
npm run build
```

Install the `esql-lsp` binary on your PATH:

```sh
npm link
# or, for a project-local install:
npm install -g /path/to/esql-lsp
```

Verify:

```sh
npm test          # unit + end-to-end LSP session over stdio
esql-lsp --help   # (any args) starts the stdio server; Ctrl-C to quit
```

### ESQL grammar (tree-sitter)

The grammar in [`tree-sitter-esql/`](tree-sitter-esql/) is a standalone
npm package (and directly consumable by nvim-treesitter):

```sh
cd tree-sitter-esql
npm install          # builds the Node addon (N-API) from binding.gyp
tree-sitter test     # 71 corpus tests in test/corpus/
```

- [`tree-sitter-esql/grammar.js`](tree-sitter-esql/grammar.js) — permissive
  superset of the IBM ACE 12.0.x ESQL railroad diagrams.
- [`tree-sitter-esql/queries/highlights.scm`](tree-sitter-esql/queries/highlights.scm) —
  highlight query (scope `source.esql`) for nvim-treesitter.
- [`tree-sitter-esql/VERIFICATION.md`](tree-sitter-esql/VERIFICATION.md) —
  construct-by-construct evidence against the IBM ESQL reference, gaps
  found/fixed and known limitations.
- [`tree-sitter-esql/README.md`](tree-sitter-esql/README.md) — grammar
  status, standalone usage, regeneration workflow.

### Development

```sh
npm test                      # build + 50 unit/e2e tests (real stdio sessions)
cd tree-sitter-esql
tree-sitter generate          # grammar.js -> src/parser.c (committed output!)
tree-sitter test              # 71 corpus tests
```

Generated grammar sources (`src/parser.c`, `src/node-types.json`, …) are
committed so consumers never need the tree-sitter CLI — regenerate them
with `tree-sitter generate` after editing `grammar.js`, never hand-edit.
Conventions, ground rules and what makes a good PR:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Neovim setup

A complete, self-contained example (filetype + server + keymaps) lives in
[`clients/neovim/init-example.lua`](clients/neovim/init-example.lua).
The essentials:

1. **Filetype mapping** — put
   [`clients/neovim/ftdetect/esql.vim`](clients/neovim/ftdetect/esql.vim)
   into your `ftdetect` directory (or add manually):

   ```vim
   au BufNewFile,BufRead *.esql set filetype=esql
   ```

2. **Start the server.** On Neovim ≥ 0.11 use the modern
   `vim.lsp.config` API:

   ```lua
   vim.lsp.config('esql', {
     cmd = { "esql-lsp" },  -- or { "node", "/abs/path/to/esql-lsp/dist/src/server.js" }
     filetypes = { "esql" },
     -- IMPORTANT: fall back to the file's own directory. If no root can be
     -- resolved, vim.lsp.enable() silently never starts the server.
     root_dir = function(bufnr)
       return vim.fs.root(bufnr, { ".git", "opencode.json", "project.xml" })
         or vim.fs.dirname(vim.api.nvim_buf_get_name(bufnr))
     end,
   })
   vim.lsp.enable('esql')
   ```

   On Neovim 0.8 – 0.10 use the `vim.lsp.start` style from
   [`clients/neovim/lsp/esql.lua`](clients/neovim/lsp/esql.lua):

   ```lua
   vim.api.nvim_create_autocmd("FileType", {
     pattern = "esql",
     callback = function()
       vim.lsp.start({
         name = "esql-lsp",
         cmd = { "esql-lsp" },   -- or { "node", "/abs/path/to/esql-lsp/dist/src/server.js" }
         root_dir = vim.fs.root(0, { ".git", "opencode.json", "project.xml" })
           or vim.fs.dirname(vim.api.nvim_buf_get_name(0)),
         filetypes = { "esql" },
       })
     end,
   })
   ```

   Verify with `:checkhealth vim.lsp` — an `esql` client should be listed
   as active with your buffer attached.

> **Syntax highlighting:** the LSP itself emits **semantic tokens** (driven
> by the grammar's `queries/highlights.scm`), which Neovim ≥ 0.10 renders
> with its built-in tree-sitter theme — no extra setup. For editor-side
> tree-sitter highlighting instead, see
> [`clients/neovim/treesitter/esql.lua`](clients/neovim/treesitter/esql.lua)
> (nvim-treesitter wiring for the local grammar). The LSP features
> (diagnostics, completion, hover, outline) work either way.

## OpenCode setup

LSP support is disabled by default in OpenCode. Merge the `lsp` section from
[`clients/opencode/opencode.jsonc`](clients/opencode/opencode.jsonc) into your
project's `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": {
    "esql": {
      "command": ["esql-lsp"],
      "extensions": [".esql"]
    }
  }
}
```

OpenCode then starts the server on first contact with a `.esql` file and
feeds published diagnostics back to the agent as feedback while it edits.

## Troubleshooting

- **Nothing happens when I open a `.esql` file.** The client probably
  never attached (or never started). Neovim: `:checkhealth vim.lsp` → the
  server must appear under *Active Clients*. The classic silent failure is
  an unresolvable root directory — see the `root_dir` note in
  [Neovim setup](#neovim-setup).
- **Which analysis mode is the server in?** At startup it logs either
  `tree-sitter grammar loaded` (full mode) or `grammar unavailable —
  heuristic mode only` (fallback). Heuristic mode still gives all Phase 1
  checks but no grammar syntax errors or semantic tokens; it happens when
  the native addon couldn't build (needs a C toolchain at `npm install`
  time). Neovim: `:lua vim.lsp.log.set_level('info')`, then `:LspLog`.
- **Changed the server code, nothing happened.** Clients spawn the built
  `dist/src/server.js` — run `npm run build`, then restart the client
  (`:LspRestart` in Neovim).
- **Diagnostics look wrong/missing?** Before blaming your editor, confirm
  what the server publishes: `test/e2e.test.ts` shows the exact stdio
  handshake to replay a session by hand.

## Configuration

Passed as LSP `initializationOptions` (Neovim: `settings` in
`vim.lsp.start`; OpenCode: `initialization` in the `lsp` entry). All default
to `true`:

```jsonc
{
  "diagnostics": {
    "enabled": true,
    "checkSyntaxErrors": true,
    "checkUndeclaredVariables": true,
    "checkPropagation": true,
    "checkMissingSemicolon": true,
    "checkDeprecatedParsers": true,
    "checkOutputRootProperties": true
  },
  "completion": {
    "enabled": true
  }
}
```

Settings apply at startup and can be updated at runtime through the
standard `workspace/didChangeConfiguration` notification (section form
`{ "esql": { ... } }` or the object directly).

## Project layout

```
bin/esql-lsp.js        # executable entrypoint (requires dist/src/server.js)
src/server.ts          # LSP wiring (stdio JSON-RPC)
src/parser.ts          # tree-sitter integration (grammar, tokens; degrades gracefully)
src/scanner.ts         # comment/string-aware masking scanner
src/diagnostics.ts     # the seven diagnostic checks
src/completion.ts      # context-sensitive completion
src/hover.ts           # hover documentation
src/symbols.ts         # document symbols
src/settings.ts        # initializationOptions / didChangeConfiguration handling
src/data/esqlData.ts   # keywords, types, tree vars, domains, functions
src/data/snippets.ts   # 43 LSP snippets
test/                  # node:test unit + e2e (real stdio LSP sessions)
clients/neovim/        # ready-to-use configs: modern (init-example.lua),
                       # legacy (lsp/esql.lua), filetype, treesitter example
clients/opencode/      # OpenCode config example
tree-sitter-esql/      # tree-sitter ESQL grammar — own package (see its README)
ATTRIBUTION.md         # upstream projects & documentation credited
CONTRIBUTING.md        # dev setup, ground rules, PR guide
```

## Roadmap

- **Phase 2 — grammar integration.** Grammar ✅ (`tree-sitter-esql/`) and
  integrated ✅: syntax-error diagnostics, exact undeclared-variable
  analysis, tree-based declared-name completion and semantic-token
  highlighting. Remaining for this phase: document symbols from the parse
  tree, go-to-definition and find-references.
- **Phase 3 — model-driven features.** MRM/XSD schema import for message-tree
  field completion, formatting.
- Longer term: optional integration with the ACE ESQL compiler for
  authoritative validation.

## Attribution

This project builds on the work of others, and we want that on the record:
keyword/function data, diagnostic rule ideas and snippets derive from
[esql-vscode](https://github.com/joaquinvulcano/esql-vscode) (Joaquín
Vulcano, MIT); the grammar is built with **tree-sitter** and its template;
the server runs on Microsoft's **vscode-languageserver**; and the grammar's
accepted language was verified construct-by-construct against **IBM's ACE
ESQL railroad diagrams**. Full credits: [ATTRIBUTION.md](ATTRIBUTION.md).

## Vibe-coded disclosure

This repository is what people now call **vibe-coded**: an AI coding agent,
in close iterative sessions with a human, produced essentially all of it —
the server, the tree-sitter grammar, the 120+ corpus/unit/e2e tests, and
the documentation. Practical consequences:

- **The tests are green, but the same tool wrote the code and the tests.**
  They encode its understanding of ESQL: strong evidence, not a proof.
- **The grammar was validated against the published IBM railroad diagrams
  and a hand-built corpus — never against the ACE compiler itself.** Known
  deviations are listed in `tree-sitter-esql/VERIFICATION.md`; unknown ones
  certainly exist. Treat "no diagnostics" as *probably fine*; the ESQL
  compiler remains the only authority.
- Naming, structure and prose are machine-templated; expect seams.

The human role was direction, scope and correctness judgment — including
running this through real Neovim sessions and fixing what bit us (a
silently-repaired missing `;`, a false-positive on multi-name `DECLARE`s,
invalid test fixtures). If you audit it and find warts — that is the
point of publishing it — open an issue or PR. AI-assisted contributions
are welcome; disclose them and ship test evidence.

## License

[MIT](LICENSE)
