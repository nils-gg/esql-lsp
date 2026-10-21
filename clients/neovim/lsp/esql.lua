-- ESQL LSP client config for Neovim (>= 0.8).
--
-- Usage:
--   1. Build/link esql-lsp so the `esql-lsp` binary is on PATH
--      (or replace `cmd` below with the node invocation, see comment).
--   2. Put the filetype mapping in `ftdetect/esql.vim` (included alongside
--      this file) or source it from your config.
--   3. Drop this file into your config (e.g. `config/lsp/esql.lua`) and
--      `require("lsp.esql")` — or just copy the autocmd.

local esql = {}

esql.filetype = "esql"

-- LSP server command. Options:
--   { "esql-lsp" }                        -- after `npm link` / install
--   { "node", "/abs/path/to/esql-lsp/dist/src/server.js" }  -- direct
local cmd = { "esql-lsp" }

-- Optional: per-check toggles, forwarded as LSP initializationOptions.
local settings = {
  diagnostics = {
    enabled = true,
    checkUndeclaredVariables = true,
    checkPropagation = true,
    checkMissingSemicolon = true,
    checkDeprecatedParsers = true,
    checkOutputRootProperties = true,
  },
  completion = {
    enabled = true,
  },
}

--- Start the ESQL server for a buffer whose filetype is `esql`.
function esql.start()
  local root_dir =
    vim.fs.root(0, { ".git", "opencode.json", "project.xml" }) or vim.uv.cwd()

  vim.lsp.start({
    name = "esql-lsp",
    cmd = cmd,
    root_dir = root_dir,
    filetypes = { esql.filetype },
    settings = settings,
    capabilities = vim.lsp.protocol.make_client_capabilities(),
  })
end

vim.api.nvim_create_autocmd("FileType", {
  pattern = esql.filetype,
  callback = function()
    esql.start()
  end,
})

return esql
