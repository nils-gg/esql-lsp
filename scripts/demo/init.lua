-- Deterministic minimal config for the recorded demo (tools/record_demo.sh).
-- Not a user example -- the user-facing Neovim setup lives in README.md.

local bin = assert(vim.env.ESQL_LSP_BIN, "ESQL_LSP_BIN not set")

vim.opt.termguicolors = true
vim.opt.number = true
vim.opt.signcolumn = "yes"
vim.opt.showmode = false
vim.opt.swapfile = false
vim.opt.backup = false
vim.opt.undofile = false
vim.opt.completeopt = "menu,menuone"
pcall(vim.cmd, "colorscheme habamax")

vim.diagnostic.config({ virtual_text = { prefix = ">>" }, severity_sort = true })

vim.filetype.add({ extension = { esql = "esql" } })
vim.api.nvim_create_autocmd("FileType", {
	pattern = "esql",
	callback = function()
		-- cwd is the demo work dir: its two .esql files make the workspace
		-- scan (ISSUES.md I-13) resolve the sibling's SHARED declarations.
		vim.lsp.start({ name = "esql-lsp", cmd = { "node", bin }, root_dir = vim.fn.getcwd() })
		-- Completion is wired as omnifunc (like the mqsc-lsp demo did): the
		-- popup opens ONLY on an explicit <C-x><C-o> in the script, never on
		-- typing. An auto-triggered menu (vim.lsp.completion) swallows a ';'
		-- typed while it is open and its C-y applies textEdits mid-word —
		-- both burned a take.
		vim.bo.omnifunc = 'v:lua.vim.lsp.omnifunc'
		local buf = 0
		vim.keymap.set("n", "<Space>gr", function()
			vim.lsp.buf.references()
			vim.schedule(function() pcall(vim.cmd, "botright copen 6") end)
		end, { buffer = buf, desc = "references" })
		vim.keymap.set("n", "<Space>ds", function()
			vim.lsp.buf.document_symbol()
			-- the tree answer arrives async; open the list once it can be there
			vim.defer_fn(function() pcall(vim.cmd, "botright lopen 8") end, 700)
		end, { buffer = buf, desc = "document symbols" })
		vim.keymap.set("n", "<Space>ws", function()
			-- fixed query: CopyMessageHeaders lives in the SIBLING file, so
			-- selecting it from this list and jumping is the cross-file shot.
			vim.lsp.buf.workspace_symbol("Copy")
			vim.defer_fn(function() pcall(vim.cmd, "botright copen 6") end, 1200)
		end, { buffer = buf, desc = "workspace symbol: Copy" })
		-- Quick fixes, rename and go-to-definition for the tour's fix-up,
		-- cross-file SHARED rename and definition-jump shots. <space> prefixes
		-- so no normal-motion (gd as "find word") is shadowed by accident.
		vim.keymap.set("n", "<Space>ca", function()
			vim.lsp.buf.code_action()
		end, { buffer = buf, desc = "quick fixes (code actions)" })
		vim.keymap.set("n", "<Space>rn", function()
			vim.lsp.buf.rename()
		end, { buffer = buf, desc = "rename" })
		vim.keymap.set("n", "<Space>gd", function()
			vim.lsp.buf.definition()
		end, { buffer = buf, desc = "go to definition" })
	end,
})
