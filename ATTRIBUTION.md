# Attribution

Parts of this project are derived from
[esql-vscode](https://github.com/joaquinvulcano/esql-vscode) by Joaquín
Vulcano, used under the [MIT License](https://github.com/joaquinvulcano/esql-vscode/blob/main/LICENSE).

Specifically:

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
