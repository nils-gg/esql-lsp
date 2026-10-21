import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SymbolKind } from 'vscode-languageserver';
import { documentSymbols } from '../src/symbols';

const SAMPLE = [
  "BROKER SCHEMA com.example.flow;",
  "",
  "CREATE COMPUTE MODULE OrderProcessing",
  "BEGIN",
  "DECLARE orderRef REFERENCE InputRoot.JSON.Data;",
  "DECLARE orderNumber INTEGER;",
  "",
  "CREATE PROCEDURE ValidateOrder(IN orderId INTEGER)",
  "BEGIN",
  "DECLARE isValid BOOLEAN;",
  "SET isValid = TRUE;",
  "END;",
  "",
  "CREATE FUNCTION Main() RETURNS BOOLEAN",
  "BEGIN",
  "SET OutputRoot.Properties = InputRoot.Properties;",
  "PROPAGATE TO TERMINAL 'out';",
  "RETURN TRUE;",
  "END;",
  "END MODULE;",
  "",
].join('\n');

function names(symbols: ReturnType<typeof documentSymbols>, level: number = 0): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    out.push(`${s.name}${level === 0 ? '' : ' <module>'}`);
    if (s.children) out.push(...names(s.children, level + 1));
  }
  return out;
}

test('extracts namespace, module, functions and variables', () => {
  const syms = documentSymbols(SAMPLE);

  const ns = syms.find((s) => s.kind === SymbolKind.Namespace);
  assert.ok(ns, 'namespace found');
  assert.equal(ns!.name, 'com.example.flow');

  const mod = syms.find((s) => s.kind === SymbolKind.Module);
  assert.ok(mod, 'module found');
  assert.equal(mod!.name, 'OrderProcessing');
  assert.equal(mod!.detail, 'COMPUTE MODULE');

  // Module spans from CREATE COMPUTE MODULE to END MODULE.
  assert.equal(mod!.range.start.line, 2);
  assert.equal(mod!.range.end.line, 19);

  const children = mod!.children ?? [];
  const fnNames = children.filter((c) => c.kind === SymbolKind.Function).map((c) => c.name);
  assert.deepEqual(fnNames, ['ValidateOrder', 'Main']);
  const varNames = children.filter((c) => c.kind === SymbolKind.Variable).map((c) => c.name);
  assert.deepEqual(varNames, ['orderRef', 'orderNumber', 'isValid']);

  // Function detail includes params.
  const validate = children.find((c) => c.name === 'ValidateOrder')!;
  assert.equal(validate.detail, 'PROCEDURE(IN orderId INTEGER)');
  assert.equal(validate.kind, SymbolKind.Function);

  // ValidateOrder body spans CREATE PROCEDURE (line 7) .. END; (line 11)
  assert.equal(validate.range.start.line, 7);
  assert.equal(validate.range.end.line, 11);

  // Main body spans CREATE FUNCTION (line 13) .. END; (line 18)
  const main = children.find((c) => c.name === 'Main')!;
  assert.equal(main.range.start.line, 13);
  assert.equal(main.range.end.line, 18);

  // Variable detail includes type.
  const orderRef = children.find((c) => c.name === 'orderRef')!;
  assert.equal(orderRef.detail, 'REFERENCE');
});

test('nested BEGIN blocks (handlers) do not close the function early', () => {
  const src = [
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "DECLARE CONTINUE HANDLER FOR SQLSTATE LIKE '%'",
    'BEGIN',
    'SET OutputRoot.Properties = InputRoot.Properties;',
    'END;',
    "PROPAGATE TO TERMINAL 'out';",
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const syms = documentSymbols(src);
  const mod = syms.find((s) => s.kind === SymbolKind.Module)!;
  const main = (mod.children ?? []).find((c) => c.name === 'Main')!;
  assert.equal(main.range.start.line, 2);
  assert.equal(main.range.end.line, 9);
});

test('a fake END MODULE inside a string does not truncate the module range', () => {
  const src = [
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    "CREATE FUNCTION Main() RETURNS BOOLEAN",
    'BEGIN',
    "SET x = 'END MODULE';",
    "PROPAGATE TO TERMINAL 'out';",
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const syms = documentSymbols(src);
  const mod = syms.find((s) => s.kind === SymbolKind.Module)!;
  assert.equal(mod.range.end.line, 7);
});

test('empty source yields no symbols', () => {
  assert.deepEqual(documentSymbols(''), []);
});
