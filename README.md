# esql-lsp

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
server for **ESQL** — the transformation language of IBM App Connect
Enterprise (ACE) / Integration Bus (IIB).

Works with any LSP client; first-class configs are included for **Neovim**
and **OpenCode**.

> Phase 1: static analysis, completion, hover and document symbols —
> pattern-based on a comment/string-aware scanner.
> A complete **tree-sitter grammar for ESQL** now lives in
> [`tree-sitter-esql/`](tree-sitter-esql/) (see
> [its verification notes](tree-sitter-esql/VERIFICATION.md)); wiring it
> into the server is the next step (see [Roadmap](#roadmap)).

## Features

### Diagnostics

| Check | Severity | Description |
|---|---|---|
| Missing `END MODULE` | 🔴 Error | Module never closed |
| Module without `Main()` | ⚠️ Warning | ACE cannot execute the module |
| `Main()` without `RETURN`/`PROPAGATE` | ⚠️ Warning | Message will not reach any terminal |
| Variable in `SET` without `DECLARE` | ⚠️ Warning | Case-insensitive; function params count as declared |
| Deprecated `XMLNS` parser | ⚠️ Warning | Use `XMLNSC` in ACE 12 |
| Missing `;` at end of statement | 💡 Hint | Heuristic on statement starters |
| `OutputRoot.JSON.Data` set without Properties copy | 💡 Hint | Very common integration bug |

All checks run on a masked view of the source where comments and string
literals are blanked, so `'END MODULE'` inside a string cannot fake a module
boundary.

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

## Neovim setup (>= 0.8)

1. Filetype mapping — put [`clients/neovim/ftdetect/esql.vim`](clients/neovim/ftdetect/esql.vim)
   into your `ftdetect` directory (or add manually):

   ```vim
   au BufNewFile,BufRead *.esql set filetype=esql
   ```

2. Start the server — put
   [`clients/neovim/lsp/esql.lua`](clients/neovim/lsp/esql.lua) in your
   config and `require("lsp.esql")`, or inline the minimum:

   ```lua
   vim.api.nvim_create_autocmd("FileType", {
     pattern = "esql",
     callback = function()
       vim.lsp.start({
         name = "esql-lsp",
         cmd = { "esql-lsp" },   -- or { "node", "/abs/path/to/esql-lsp/dist/src/server.js" }
         root_dir = vim.uv.cwd(),
         filetypes = { "esql" },
       })
     end,
   })
   ```

> **Syntax highlighting is not wired up yet.** The tree-sitter grammar now
> exists in this repo ([`tree-sitter-esql/`](tree-sitter-esql/)); Neovim
> users can point nvim-treesitter at it for `source.esql` highlighting, but
> the LSP ships no highlighting of its own. The LSP features (diagnostics,
> completion, hover, outline) work without it.

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

## Configuration

Passed as LSP `initializationOptions` (Neovim: `settings` in
`vim.lsp.start`; OpenCode: `initialization` in the `lsp` entry). All default
to `true`:

```jsonc
{
  "diagnostics": {
    "enabled": true,
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

## Project layout

```
bin/esql-lsp.js        # executable entrypoint (requires dist/src/server.js)
src/server.ts          # LSP wiring (stdio JSON-RPC)
src/scanner.ts         # comment/string-aware masking scanner
src/diagnostics.ts     # the seven diagnostic checks
src/completion.ts      # context-sensitive completion
src/hover.ts           # hover documentation
src/symbols.ts         # document symbols
src/settings.ts        # initializationOptions handling
src/data/esqlData.ts   # keywords, types, tree vars, domains, functions
src/data/snippets.ts   # 43 LSP snippets
test/                  # node:test unit + e2e (real stdio LSP session)
clients/neovim/        # Neovim config + filetype mapping
clients/opencode/      # OpenCode config example
tree-sitter-esql/      # tree-sitter ESQL grammar (see section above)
```

## Roadmap

- **Phase 2 — grammar integration.** The tree-sitter grammar is done
  ([`tree-sitter-esql/`](tree-sitter-esql/): permissive superset of the IBM
  railroads, 71-test corpus, highlights query, Node bindings). Remaining:
  consume the parse tree in this server for accurate symbols, references and
  grammar-backed diagnostics, and ship the nvim-treesitter highlight setup.
- **Phase 3 — model-driven features.** MRM/XSD schema import for message-tree
  field completion, go-to-definition, find references, formatting.
- Longer term: optional integration with the ACE ESQL compiler for
  authoritative validation.

## Attribution

Keyword/function data, diagnostic rule ideas and snippets are derived from
[esql-vscode](https://github.com/joaquinvulcano/esql-vscode)
(Joaquín Vulcano, MIT). See [ATTRIBUTION.md](ATTRIBUTION.md).

## License

[MIT](LICENSE)
