# tree-sitter-esql

A [tree-sitter](https://tree-sitter.github.io/) grammar for **ESQL**, the
transformation language of IBM App Connect Enterprise (ACE) / Integration
Bus (IIB).

It powers the parser layer of [esql-lsp](../README.md) (syntax errors,
declared-variable analysis, semantic tokens) and can be used standalone —
e.g. with nvim-treesitter (see the wiring example in
[`clients/neovim/treesitter/esql.lua`](../clients/neovim/treesitter/esql.lua)).

## Status

- Permissive **superset** of the IBM ACE 12.0.x ESQL railroad diagrams:
  anything the railroads accept should parse; several constructs the
  diagrams underspecify (terminator placement, clause order) are accepted
  liberally on purpose.
- 89 corpus tests (`test/corpus/`), all passing on tree-sitter CLI 0.27.
- Construct-by-construct verification evidence, found gaps and known
  limitations: [VERIFICATION.md](VERIFICATION.md).
- Differentially checked against a real ACE 13.0.9 ESQL compiler, probe by
  probe (methodology and verdict ledger:
  [ACE-COMPILER-DIFFERENTIAL.md](ACE-COMPILER-DIFFERENTIAL.md); harness:
  [`scripts/ace-differential/`](../scripts/ace-differential/)).
- Node bindings only; the other template bindings were pruned. The C
  sources (`src/parser.c`) compile standalone, which is all an editor
  needs.

## Usage

As a package (Node):

```sh
npm install          # runs node-gyp-build against binding.gyp
node -e "
const P = require('tree-sitter');
import('tree-sitter-esql').then(m => {
  const p = new P(); p.setLanguage(m.default);
  console.log(p.parse('DECLARE x INT 1;').rootNode.toString());
});
"
```

Grammar development:

```sh
npm install -g tree-sitter-cli   # or use npx
tree-sitter generate             # grammar.js -> src/parser.c
tree-sitter test                 # corpus tests
tree-sitter parse some.esql      # inspect the parse tree
```

Regenerating after editing `grammar.js` changes `src/parser.c` and
`src/node-types.json` / `src/grammar.json` — those generated files are
committed, so consumers never need the CLI.

## Highlights

`queries/highlights.scm` provides TextMate-style captures (`keyword.control`,
`type`, `variable`, `parameter`, `function.call`, `module`, …) consumed both
by nvim-treesitter and by esql-lsp's LSP semantic tokens.

## License

[MIT](LICENSE). See the parent repo's
[ATTRIBUTION.md](../ATTRIBUTION.md) for the upstream projects and reference
documentation this grammar was built on.
