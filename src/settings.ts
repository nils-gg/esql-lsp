/**
 * Server settings. Configuration is passed via LSP `initializationOptions`
 * (Neovim: `settings = {...}` in `vim.lsp.start`, OpenCode: `initialization`
 * in the `lsp` config section) and may be updated at runtime through
 * `workspace/didChangeConfiguration` — the server accepts either
 * `{ esql: {...} }` or the settings object directly.
 */

export interface EsqlDiagnosticsSettings {
  /** Master switch for all diagnostics. */
  enabled: boolean;
  /** Syntax errors from the tree-sitter parse (ERROR/MISSING nodes). */
  checkSyntaxErrors: boolean;
  /** Warn when a variable is assigned in SET without a DECLARE. */
  checkUndeclaredVariables: boolean;
  /** Warn when Main() has neither RETURN nor PROPAGATE. */
  checkPropagation: boolean;
  /** Hint when a statement likely lacks a terminating `;`. */
  checkMissingSemicolon: boolean;
  /** Warn when the deprecated XMLNS parser is used instead of XMLNSC. */
  checkDeprecatedParsers: boolean;
  /** Hint when building OutputRoot.JSON.Data without copying Properties. */
  checkOutputRootProperties: boolean;
}

export interface EsqlSettings {
  diagnostics: EsqlDiagnosticsSettings;
  completion: {
    enabled: boolean;
  };
}

export const DEFAULT_SETTINGS: EsqlSettings = {
  diagnostics: {
    enabled: true,
    checkSyntaxErrors: true,
    checkUndeclaredVariables: true,
    checkPropagation: true,
    checkMissingSemicolon: true,
    checkDeprecatedParsers: true,
    checkOutputRootProperties: true,
  },
  completion: {
    enabled: true,
  },
};

function pick(obj: unknown): Record<string, unknown> {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
}

function bool(obj: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = obj[key];
  return typeof v === 'boolean' ? v : dflt;
}

/**
 * Unwrap the two shapes a client may send for this server's settings: the
 * settings object directly, or the section form `{ esql: { ... } }` that a
 * client keying settings by configuration section sends.
 *
 * Both `initializationOptions` and `workspace/didChangeConfiguration` must go
 * through this, or the same configuration works in one path and is silently
 * ignored in the other (ISSUES.md I-22.3: the wrapper used to be honoured only
 * by didChangeConfiguration, so `{ esql: { diagnostics: { … } } }` at
 * initialize did nothing at all).
 */
export function unwrapSettings(raw: unknown): unknown {
  const obj = pick(raw);
  const esql = obj['esql'];
  return esql && typeof esql === 'object' ? esql : raw;
}

/** Merge client-supplied initializationOptions over the defaults. */
export function mergeSettings(initOptions: unknown): EsqlSettings {
  const root = pick(initOptions);
  const d = pick(root['diagnostics']);
  const c = pick(root['completion']);

  return {
    diagnostics: {
      enabled: bool(d, 'enabled', true),
      checkSyntaxErrors: bool(d, 'checkSyntaxErrors', true),
      checkUndeclaredVariables: bool(d, 'checkUndeclaredVariables', true),
      checkPropagation: bool(d, 'checkPropagation', true),
      checkMissingSemicolon: bool(d, 'checkMissingSemicolon', true),
      checkDeprecatedParsers: bool(d, 'checkDeprecatedParsers', true),
      checkOutputRootProperties: bool(d, 'checkOutputRootProperties', true),
    },
    completion: {
      enabled: bool(c, 'enabled', true),
    },
  };
}
