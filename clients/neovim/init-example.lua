-- Complete, self-contained Neovim (>= 0.11) configuration for esql-lsp.
--
-- Copy the two sections below into your init.lua (or source this file),
-- adjust the server `cmd`, and restart Neovim. For Neovim 0.8–0.10 see
-- the legacy vim.lsp.start variant in lsp/esql.lua.

-- ── 1. Filetype: treat *.esql as ESQL ────────────────────────────────────────
vim.api.nvim_create_autocmd({ "BufNewFile", "BufRead" }, {
  pattern = "*.esql",
  callback = function() vim.bo.filetype = "esql" end,
})

-- ── 2. Language server ───────────────────────────────────────────────────────
vim.lsp.config("esql", {
  -- Option A: after `npm link` in the esql-lsp repo (binary on $PATH):
  cmd = { "esql-lsp" },

  -- Option B: straight from a checkout, no global install:
  -- cmd = { "node", "/ABS/PATH/TO/esql-lsp/dist/src/server.js" },

  filetypes = { "esql" },

  -- IMPORTANT: always resolve a root. If no root can be found,
  -- vim.lsp.enable() silently does nothing — no client, no error.
  -- The dirname() fallback below makes lone files (e.g. in /tmp) work.
  root_dir = function(bufnr)
    return vim.fs.root(bufnr, { ".git", "opencode.json", "project.xml" })
      or vim.fs.dirname(vim.api.nvim_buf_get_name(bufnr))
  end,

  -- Optional per-check toggles (all default to true). These are sent as
  -- initializationOptions; the server also honors runtime
  -- workspace/didChangeConfiguration in the same shape.
  settings = {
    diagnostics = {
      enabled = true,
      checkSyntaxErrors = true,          -- grammar-backed syntax errors
      checkUndeclaredVariables = true,   -- SET without DECLARE
      checkPropagation = true,           -- Main() must RETURN/PROPAGATE
      checkMissingSemicolon = true,      -- heuristic hint (idle when grammar is active)
      checkDeprecatedParsers = true,     -- XMLNS -> XMLNSC
      checkOutputRootProperties = true,  -- JSON.Data without Properties copy
    },
    completion = { enabled = true },
  },
})
vim.lsp.enable("esql")

-- ── 3. Nice-to-haves in ESQL buffers ─────────────────────────────────────────
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(ev)
    if vim.bo[ev.buf].filetype ~= "esql" then return end

    -- Hover docs on K come built-in with Neovim's LSP; these add the rest:
    vim.keymap.set("n", "gH", vim.lsp.buf.hover,
      { buffer = ev.buf, desc = "ESQL: hover docs" })
    vim.keymap.set("i", "<C-Space>", vim.lsp.completion.trigger,
      { buffer = ev.buf, desc = "ESQL: trigger completion" })
    vim.keymap.set("n", "<leader>eo", "<cmd>Symbols<cr>",
      { buffer = ev.buf, desc = "ESQL: outline (modules/functions/vars)" })

    -- Note: gd/gr (definition/references) are on the roadmap, not wired yet.
  end,
})

-- Diagnostic display preference (uncomment to see messages inline):
-- vim.diagnostic.config({ virtual_text = true })
