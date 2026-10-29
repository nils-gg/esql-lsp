Issues

- Incorrect LSP positions with non-ASCII characters — Tree-sitter columns are byte offsets, while LSP positions use character offsets. Diagnostics/navigation may be wrong after characters such as é, CJK text, or emoji.
- Workspace rename can affect unrelated symbols — Cross-file rename/reference matching is still largely name-based and may catch unrelated variables or routines with the same name.
- Routine resolution can be ambiguous across modules — Procedures/functions with the same name in different modules do not appear to have a sufficiently strong unique symbol identity.
- Quoted identifiers are handled too lexically — Regex/raw-line handling can potentially confuse quoted identifiers with occurrences inside comments or strings and may mishandle escaped quotes.
- Workspace index becomes stale — Changes made to closed .esql files outside the editor may not be reflected until the language server restarts.
- Multi-root workspace support is incomplete — Initialization appears focused on the first workspace folder.
- Platform coverage is limited — CI primarily validates Linux, leaving possible Windows/macOS issues around paths, URIs, native Tree-sitter components, and line endings.
- Grammar/compiler compatibility is not fully validated — The grammar has not been systematically checked against the ACE compiler, so accepted/rejected syntax may diverge.
- Some ESQL syntax remains unsupported or incomplete — Examples noted in the project include areas such as COPY, LOG ... VALUES, spaced ELSE IF, and some DECLARE/CALL forms.

Enhancements

- Introduce stable semantic Symbol IDs — Identify declarations using URI, module, symbol kind, declaration location, etc., instead of primarily by name.
- Build a resolved reference graph — Resolve each reference to its actual declaration once and reuse that information for definition, references, hover, and rename.
- Make rename conservative and semantic — Only rename references that are proven to resolve to the selected declaration.
- Add a dedicated Tree-sitter → LSP position conversion layer — Centralize UTF-8 byte-offset to LSP UTF-16 position handling.
- Add Unicode regression tests — Include accented characters, emoji, CJK, and mixed Unicode before diagnostics and navigation targets.
- Tokenize quoted identifiers properly — Represent quoted identifiers as scanner/parser tokens containing both the source range and normalized identifier value.
- Add incremental workspace indexing — Update only affected .esql files when files are created, changed, or deleted.
- Support workspace/didChangeWatchedFiles — Keep symbols from closed files synchronized with filesystem changes.
- Support workspace-folder changes — Handle workspace/didChangeWorkspaceFolders and maintain indexes per workspace root.
- Add project/application-aware symbol scope — Avoid treating an entire editor workspace as one flat ACE application namespace.
- Add incremental Tree-sitter parsing — Reuse existing syntax trees and apply edits rather than reparsing the entire document on every change.
- Add Windows and macOS CI jobs — At minimum test installation, build, packaging, and a small LSP smoke test.
- Add CRLF/path/URI tests — Especially important for Windows behavior.
- Create an ACE compiler validation corpus — Compare parser acceptance/rejection against the real ACE compiler.
- Add differential grammar tests — Keep examples of syntax where the grammar and ACE previously disagreed to prevent regressions.
- Expand ESQL grammar coverage — Gradually implement the unsupported syntax already listed in the roadmap.
- Add performance benchmarks — Track parse time, workspace-index time, completion latency, and memory usage on large ESQL projects.
- Add large-workspace tests — Exercise hundreds/thousands of .esql files to expose indexing and symbol-resolution scaling issues.
- Add rename safety regression tests — Test identical names across local variables, shared variables, modules, procedures, and files.
- Add cross-module definition/reference tests — Particularly duplicate routine names and qualified/unqualified calls.
- Version/cache workspace-index data carefully — If indexing becomes more sophisticated, cache parsed/indexed data between sessions and invalidate it based on file modification/hash.
- Improve diagnostics around ambiguous symbols — When more than one declaration could match, report ambiguity rather than silently choosing one.
- Consider an internal symbol-resolution API — Keep parsing, indexing, navigation, rename, hover, and completion consuming one shared semantic model instead of implementing their own lookup rules.
