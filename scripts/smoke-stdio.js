#!/usr/bin/env node
/**
 * Stdio smoke test: starts the BUILT server exactly the way an editor does and
 * checks that it answers. Meant to run after `npm run build`, on a machine with
 * or without a working native addon.
 *
 *   node scripts/smoke-stdio.js                   # mode-agnostic checks
 *   node scripts/smoke-stdio.js --expect-heuristic  # forces ESQL_LSP_NO_GRAMMAR=1
 *   node scripts/smoke-stdio.js --expect-grammar    # addon must be active
 *
 * The CI "no C toolchain" job uses --expect-heuristic: it is the cheapest proof
 * that a user without a compiler still gets a working language server.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = path.join(root, 'bin', 'esql-lsp.js');
const argv = process.argv.slice(2);
const expectHeuristic = argv.includes('--expect-heuristic');
const expectGrammar = argv.includes('--expect-grammar');

const SOURCE = [
  'BROKER SCHEMA com.acme;', // 0
  'CREATE COMPUTE MODULE Smoke', // 1
  'CREATE FUNCTION Main() RETURNS BOOLEAN', // 2
  'BEGIN', // 3
  "SET note = 'hello';", // 4  (note is never declared)
  'RETURN TRUE;', // 5
  'END;', // 6
  // no END MODULE on purpose
  '',
].join('\n');

if (!fs.existsSync(server)) {
  console.error(`esql-lsp: ${server} not found — run 'npm run build' first`);
  process.exit(1);
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const child = spawn(process.execPath, [server], {
  stdio: 'pipe',
  env: expectHeuristic ? { ...process.env, ESQL_LSP_NO_GRAMMAR: '1' } : process.env,
});

let buffer = Buffer.alloc(0);
const messages = [];
const stderr = [];
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
    if (!match) return;
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    messages.push(JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()));
    buffer = buffer.subarray(headerEnd + 4 + length);
  }
});
child.stderr.on('data', (d) => stderr.push(d.toString()));
child.on('error', (err) => {
  console.error('esql-lsp: failed to start the server:', err.message);
  process.exit(1);
});

function send(message) {
  const body = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function waitFor(predicate, label, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const found = messages.find(predicate);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    const interval = setInterval(() => {
      const msg = messages.find(predicate);
      if (msg) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(msg);
      }
    }, 25);
  });
}

async function request(id, method, params) {
  send({ jsonrpc: '2.0', id, method, params });
  return waitFor((m) => m.id === id, `${method} response`);
}

const URI = 'file:///tmp/esql-smoke/Smoke.esql';

async function main() {
  const init = await request(1, 'initialize', {
    processId: process.pid,
    rootUri: null,
    // A client that can read the nested outline. The server answers
    // `documentSymbol` in the shape the client declared, so a smoke client that
    // declared nothing would (correctly) get the flat `SymbolInformation[]`
    // list and this script's nesting check below would be meaningless. The flat
    // shape is asserted in test/e2e.test.ts.
    capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: {},
  });
  const caps = init.result.capabilities;
  check('initializes and advertises providers', Boolean(caps.definitionProvider && caps.referencesProvider && caps.documentSymbolProvider));
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: URI, languageId: 'esql', version: 1, text: SOURCE } },
  });

  // The heuristic module-stack check reports the missing END MODULE in both modes.
  const diagnostics = await waitFor(
    (m) =>
      m.method === 'textDocument/publishDiagnostics' &&
      m.params.uri === URI &&
      m.params.diagnostics.some((d) => /END MODULE/.test(d.message)),
    'diagnostics about the missing END MODULE'
  );
  check(
    'diagnoses the undeclared variable',
    diagnostics.params.diagnostics.some((d) => /'note'/.test(d.message)),
    JSON.stringify(diagnostics.params.diagnostics.map((d) => d.message))
  );

  const symbols = await request(2, 'textDocument/documentSymbol', { textDocument: { uri: URI } });
  const module = (symbols.result ?? []).find((s) => s.name === 'Smoke');
  check(
    'outlines the module with its routine nested inside',
    Boolean(module && (module.children ?? []).some((c) => c.name === 'Main')),
    JSON.stringify((symbols.result ?? []).map((s) => s.name))
  );

  // `SET note = ...` on line 4; there is no declaration, so the answer is empty —
  // hovering the routine name instead must document it.
  const hover = await request(3, 'textDocument/hover', {
    textDocument: { uri: URI },
    position: { line: 2, character: 20 },
  });
  check(
    'hover documents the user-defined function',
    Boolean(hover.result) && /CREATE FUNCTION Main/.test(hover.result.contents.value),
    hover.result ? hover.result.contents.value.split('\n')[0] : 'null'
  );

  const tokens = await request(4, 'textDocument/semanticTokens/full', { textDocument: { uri: URI } });
  const data = (tokens.result ?? tokens).data ?? [];
  if (expectHeuristic) {
    check('no semantic tokens without the grammar (by design)', data.length === 0, `data length ${data.length}`);
    check(
      'server says it is in heuristic mode',
      stderr.join('').includes('heuristics only') || stderr.join('').includes('ESQL_LSP_NO_GRAMMAR'),
      stderr.join('').trim().split('\n')[0]
    );
  } else if (expectGrammar) {
    check('semantic tokens come from the parse tree', data.length > 0 && data.length % 5 === 0, `data length ${data.length}`);
  } else {
    check('semantic token request is answered', Array.isArray(data), `data length ${data.length}`);
  }

  // shutdown must be a real request: the server exits 0 only after a shutdown,
  // and 1 if the client drops the connection without one (LSP spec).
  await request(5, 'shutdown', null);
  send({ jsonrpc: '2.0', method: 'exit' });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  check('shuts down cleanly', code === 0, `exit code ${code}`);
}

main()
  .then(() => {
    child.kill();
    if (failures) {
      console.error(`\n${failures} smoke check(s) failed`);
      console.error(stderr.join(''));
      process.exit(1);
    }
    console.log('stdio smoke test passed');
    process.exit(0);
  })
  .catch((err) => {
    child.kill();
    console.error('esql-lsp: stdio smoke test failed:', err.message);
    console.error(stderr.join(''));
    process.exit(1);
  });
