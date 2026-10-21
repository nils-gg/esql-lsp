-- Optional: ESQL syntax highlighting via nvim-treesitter.
--
-- NOTE: esql-lsp already provides highlighting through LSP semantic tokens
-- (Neovim >= 0.10 renders them out of the box, no extra setup). This file is
-- the alternative for users who prefer tree-sitter highlighting in the
-- editor itself, or who want textobjects/injections later.
--
-- Requires nvim-treesitter (the master branch). Point install_info.url at
-- this repository's grammar directory, then run :TSUpdate esql (or
-- :TSCompile esql) once.

local parser_config = require('nvim-treesitter.parsers').get_parser_configs()
parser_config.esql = {
  install_info = {
    url = '~/projects/esql-lsp/tree-sitter-esql', -- your checkout's grammar dir
    files = { 'src/parser.c' },
    generate_requires_npm = false,
    require_beautifier = false,
  },
  filetype = 'esql',
}

require('nvim-treesitter.configs').setup({
  ensure_installed = { 'esql' },
  highlight = { enable = true },
})
