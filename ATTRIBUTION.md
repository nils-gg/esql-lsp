# Attribution

esql-lsp stands on the shoulders of several open-source projects and one
body of vendor documentation. None of this existed before them; we are
glad to credit each one.

## Code and data derived from other projects

### esql-vscode — Joaquín Vulcano ([MIT](https://github.com/joaquinvulcano/esql-vscode/blob/main/LICENSE))

Parts of this project are derived from
[esql-vscode](https://github.com/joaquinvulcano/esql-vscode) by Joaquín
Vulcano, used under the MIT License. Specifically:

- The ESQL keyword list, message tree variables, parser/domain list and
  built-in function documentation (`src/data/esqlData.ts`) — ported from
  `src/esqlData.ts`, translated to English and extended with additional
  built-in functions.
- The six diagnostic rule ideas (module structure, undeclared variables,
  Main() propagation, missing semicolons, deprecated `XMLNS` parser,
  OutputRoot JSON without Properties copy) (`src/diagnostics.ts`). The
  implementations were rewritten around a proper scanner that masks comments
  and string literals before pattern matching.
- The code snippets (`src/data/snippets.ts`) — ported from
  `snippets/esql.code-snippets`, with titles and placeholder text translated
  to English.

## Tools and libraries this is built on

- **[tree-sitter](https://tree-sitter.github.io/)** (MIT) — the parser
  generator and runtime. The grammar (`tree-sitter-esql/`) was written for
  and is maintained against the **tree-sitter CLI** and the **`tree-sitter`
  Node bindings**, both part of the same project. The grammar's package
  layout, `binding.gyp`, Node binding glue and `.gitattributes` started
  from the `tree-sitter init` project template. Many thanks to the
  tree-sitter maintainers (Matthew Brunsfeld, Clayton Carey and
  contributors) for the tooling and its documentation.
- **[vscode-languageserver](https://github.com/microsoft/vscode-languageserver-node)**
  and **vscode-languageserver-textdocument** (MIT, Microsoft) — the
  JSON-RPC/connection layer and document synchronization in `src/server.ts`.
- **[node-addon-api](https://github.com/nodejs/node-addon-api)** (MIT) and
  **[node-gyp-build](https://github.com/prebuild/node-gyp-build)** (MIT) —
  the N-API surface and the install-time native build of the grammar addon.
- **[Neovim](https://neovim.io/)** — the primary client this server is
  tuned against, including its built-in LSP and semantic-token rendering;
  the configs under `clients/neovim/` follow current upstream practice.
- The **Language Server Protocol** specification itself (Microsoft).

## Reference documentation

- **IBM documentation for App Connect Enterprise 12.0.x** — the ESQL
  railroad diagrams and ESQL reference in the IBM Knowledge Center are the
  normative source for the grammar's accepted language and for
  `tree-sitter-esql/VERIFICATION.md`. The diagrams are © IBM; no IBM code
  or documentation text is redistributed here — the grammar was written
  from the language *concepts* the diagrams describe.

## A note on how this was made

This project was vibe-coded — written almost entirely through AI/LLM
pairing sessions (planning, grammar, implementation, tests and docs). The
human direction decided scope, correctness judgments and what "done"
means; the production of code and prose was heavily assisted. See the
vibe-coded notice at the top of the [README](README.md).
