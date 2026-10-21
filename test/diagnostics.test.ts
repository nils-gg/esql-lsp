import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { analyze } from '../src/diagnostics';
import { DEFAULT_SETTINGS } from '../src/settings';

const D = DEFAULT_SETTINGS.diagnostics;

/** Returns messages grouped by severity for a source. */
function messages(source: string): { errors: string[]; warnings: string[]; hints: string[] } {
  const diags = analyze(source, D);
  const out = { errors: [] as string[], warnings: [] as string[], hints: [] as string[] };
  for (const d of diags) {
    if (d.severity === DiagnosticSeverity.Error) out.errors.push(d.message);
    else if (d.severity === DiagnosticSeverity.Warning) out.warnings.push(d.message);
    else if (d.severity === DiagnosticSeverity.Hint) out.hints.push(d.message);
  }
  return out;
}

const CLEAN_MODULE = [
  "BROKER SCHEMA com.test;",
  "CREATE COMPUTE MODULE TestModule",
  "BEGIN",
  "CREATE FUNCTION Main() RETURNS BOOLEAN",
  "BEGIN",
  "SET OutputRoot.Properties = InputRoot.Properties;",
  "SET OutputRoot.JSON.Data.msg = 'ok';",
  "PROPAGATE TO TERMINAL 'out';",
  "RETURN TRUE;",
  "END;",
  "END MODULE;",
  "",
].join('\n');

test('clean module produces no diagnostics', () => {
  const { errors, warnings, hints } = messages(CLEAN_MODULE);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(hints, []);
});

test('missing END MODULE is an error', () => {
  const src = CLEAN_MODULE.replace('END MODULE;', '');
  const { errors } = messages(src);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing its closing 'END MODULE'/);
});

test('module without Main() is a warning', () => {
  const src = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE NoMain',
    'BEGIN',
    'END MODULE;',
    '',
  ].join('\n');
  const { warnings } = messages(src);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no Main\(\) function/);
});

test('Main() without RETURN/PROPAGATE is a warning', () => {
  const src = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "SET OutputRoot.Properties = InputRoot.Properties;",
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const { warnings } = messages(src);
  assert.ok(warnings.some((w) => /neither RETURN nor PROPAGATE/.test(w)));
});

test('undeclared variable in SET is a warning (case-insensitive)', () => {
  const withDecl = [
    'DECLARE foo CHARACTER;',
    'SET foo = \'x\';',
    '',
  ].join('\n');
  assert.deepEqual(messages(withDecl).warnings, []);

  const undeclared = 'SET foo = \'x\';\n';
  const w1 = messages(undeclared).warnings;
  assert.equal(w1.length, 1);
  assert.match(w1[0], /Variable 'foo'/);

  // DECLARE with different case must suppress the warning.
  const mixedCase = 'DECLARE FOO CHARACTER;\nSET foo = \'x\';\n';
  assert.deepEqual(messages(mixedCase).warnings, []);
});

test('tree root assignments are not flagged as undeclared', () => {
  const src = [
    'SET OutputRoot.Properties = InputRoot.Properties;',
    'SET OutputRoot.JSON.Data.x = 1;',
    'SET Environment.myVar = 1;',
    '',
  ].join('\n');
  assert.deepEqual(messages(src).warnings, []);
});

test('deprecated XMLNS parser is a warning, XMLNSC is not', () => {
  const bad = "DECLARE x CHARACTER;\nSET x = InputRoot.XMLNS.Root.Data;\n";
  const w = messages(bad).warnings;
  assert.ok(w.some((m) => /XMLNSC/.test(m)));

  const good = "DECLARE x CHARACTER;\nSET x = InputRoot.XMLNSC.Root.Data;\n";
  assert.deepEqual(messages(good).warnings, []);
});

test('missing semicolon is a hint', () => {
  const bad = 'SET OutputRoot.Properties = InputRoot.Properties\n';
  const hints = messages(bad).hints;
  assert.equal(hints.length, 1);
  assert.match(hints[0], /missing semicolon/);

  const good = 'SET OutputRoot.Properties = InputRoot.Properties;\n';
  assert.equal(messages(good).hints.length, 0);
});

test('strings cannot fake END MODULE or trigger false positives', () => {
  const src = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "SET OutputRoot.Properties = InputRoot.Properties;",
    "SET x = 'END MODULE; BEGIN SET y = 1';",
    "SET y = '2024-01-15 -- not a comment';",
    "PROPAGATE TO TERMINAL 'out';",
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const { errors, warnings } = messages(src);
  assert.deepEqual(errors, []);
  // The SET y line ends with a string containing '--' — must not look
  // unterminated, and no fake structure issues.
  assert.ok(warnings.every((w) => !/END MODULE/.test(w)));
});

test('multi-line THROW is not flagged as missing semicolon', () => {
  const src = [
    'THROW USER EXCEPTION',
    '\tMESSAGE 2951',
    '\tSEVERITY 3',
    "\tCATALOG 'BIPmsgs'",
    "\tVALUES('err');",
    '',
  ].join('\n');
  assert.equal(messages(src).hints.length, 0);
});

test('OutputRoot JSON without Properties copy is a hint', () => {
  const src = [
    'SET OutputRoot.JSON.Data.x = 1;',
    '',
  ].join('\n');
  const hints = messages(src).hints;
  assert.ok(hints.some((h) => /Properties/.test(h)));

  const withCopy = [
    'SET OutputRoot.Properties = InputRoot.Properties;',
    'SET OutputRoot.JSON.Data.x = 1;',
    '',
  ].join('\n');
  assert.deepEqual(messages(withCopy).hints, []);
});

test('diagnostics can be disabled via settings', () => {
  // Module structure (ungated) is satisfied: Main() present, END MODULE present.
  const src = [
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const allOff = {
    enabled: true,
    checkUndeclaredVariables: false,
    checkPropagation: false,
    checkMissingSemicolon: false,
    checkDeprecatedParsers: false,
    checkOutputRootProperties: false,
  };
  assert.deepEqual(analyze(src, allOff), []);
  assert.deepEqual(analyze(src, { ...allOff, enabled: false }), []);
});
