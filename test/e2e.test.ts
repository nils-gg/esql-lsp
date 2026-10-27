/**
 * End-to-end test: spawns the compiled server as a child process and speaks
 * LSP over stdio (Content-Length framed JSON-RPC) — the same protocol
 * Neovim and OpenCode use against it.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { initGrammar } from '../src/parser';
import { skipWithoutGrammar } from './grammarStatus';

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

const BAD = [
  'BROKER SCHEMA com.test;',
  'CREATE COMPUTE MODULE TestModule',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  'SET OutputRoot.Properties = InputRoot.Properties;',
  "SET myVar = 'hello';",
  "PROPAGATE TO TERMINAL 'out';",
  'END;',
  // Missing: END MODULE;  (and myVar is never DECLAREd)
  '',
].join('\n');

const FIXED = [
  'BROKER SCHEMA com.test;',
  'CREATE COMPUTE MODULE TestModule',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  'SET OutputRoot.Properties = InputRoot.Properties;',
  'DECLARE myVar CHARACTER;',
  "SET myVar = 'hello';",
  'SET OutputRoot.JSON.Data.msg = myVar;',
  "PROPAGATE TO TERMINAL 'out';",
  'RETURN TRUE;',
  'END;',
  'END MODULE;',
  '',
].join('\n');

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private nextId = 1;
  private notifications: Array<{ method: string; params: any }> = [];
  /** Requests the SERVER sent to us (id + method), in arrival order. */
  readonly serverRequests: string[] = [];
  private readonly serverRequestBodies: Array<{ method: string; params: any }> = [];
  /** Params of the server→client requests sent for `method` (in order). */
  serverRequestCalls(method: string): any[] {
    return this.serverRequestBodies.filter((c) => c.method === method).map((c) => c.params);
  }
  /** Set once the child process is gone, so a test can prove it did not die. */
  exited: { code: number | null; signal: string | null } | null = null;
  private waiters: Array<{
    method: string;
    predicate: (params: any) => boolean;
    resolve: (params: any) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    options: {
      env?: NodeJS.ProcessEnv;
      /**
       * How to answer a request the server sends us. A real client that does
       * not implement a server→client request answers `-32601`; that reply used
       * to kill the server (ISSUES.md I-14), so tests can drive it deliberately.
       * Default: ignore (leave the request unanswered), as the old tests did.
       */
      onServerRequest?: 'method-not-found' | 'ok' | 'ignore';
    } = {}
  ) {
    this.child = spawn(process.execPath, [SERVER], {
      stdio: 'pipe',
      // ESQL_LSP_NO_GRAMMAR=1 is passed in to exercise the heuristic-only mode
      // (the same degraded environment a machine without a C toolchain gets).
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    this.onServerRequest = options.onServerRequest ?? 'ignore';
    this.child.stdout.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr.on('data', () => {
      /* server logs to stderr are expected; ignore */
    });
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
    });
  }

  private readonly onServerRequest: 'method-not-found' | 'ok' | 'ignore';

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length: (\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(JSON.parse(body) as JsonRpcMessage);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && msg.method) {
      // A server→client request: answer like a real client would.
      this.serverRequests.push(msg.method);
      this.serverRequestBodies.push({ method: msg.method, params: msg.params });
      if (this.onServerRequest === 'method-not-found') {
        this.write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Unhandled method ${msg.method}` },
        });
      } else if (this.onServerRequest === 'ok') {
        this.write({ jsonrpc: '2.0', id: msg.id, result: null });
      }
      return;
    }
    if (msg.id !== undefined) {
      const cb = this.pending.get(msg.id);
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg);
      }
      return;
    }
    if (msg.method) {
      this.notifications.push({ method: msg.method, params: msg.params });
      this.waiters = this.waiters.filter((w) => {
        if (w.method !== msg.method) return true;
        if (!w.predicate(msg.params)) return true;
        clearTimeout(w.timer);
        w.resolve(msg.params);
        return false;
      });
    }
  }

  private write(msg: JsonRpcMessage): void {
    const body = JSON.stringify(msg);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  notify(method: string, params: any): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`request ${method} timed out`)),
        10000
      );
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Resolves when the server sends a request named `method` to us. */
  waitForServerRequest(method: string, timeoutMs = 10000): Promise<void> {
    if (this.serverRequests.includes(method)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (this.serverRequests.includes(method)) return resolve();
        if (this.exited) return reject(new Error(`server exited ${JSON.stringify(this.exited)}`));
        if (Date.now() > deadline) return reject(new Error(`no ${method} request; saw ${JSON.stringify(this.serverRequests)}`));
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  waitFor(method: string, predicate: (params: any) => boolean, timeoutMs = 10000): Promise<any> {
    const past = this.notifications.find((n) => n.method === method && predicate(n.params));
    if (past) return Promise.resolve(past.params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        timeoutMs
      );
      this.waiters.push({ method, predicate, resolve, timer });
    });
  }

  async close(): Promise<void> {
    this.child.kill();
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
  }
}

test('full LSP session over stdio: diagnostics, completion, symbols', async () => {
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/TestModule.esql';
  try {
    // ── initialize ─────────────────────────────────────────────────────────
    const init = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      // A client that can read the nested outline (Neovim, VS Code both declare
      // this); the flat shape is covered by the heuristic-mode session below.
      capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      initializationOptions: { diagnostics: { checkMissingSemicolon: false } },
    });
    const caps = init.result.capabilities;
    assert.ok(caps.completionProvider, 'completion capability');
    // I-22: `save: true` used to be advertised with no didSave handler behind it.
    assert.equal(caps.textDocumentSync.save, undefined, 'no save handler is advertised');
    assert.ok(caps.hoverProvider, 'hover capability');
    assert.ok(caps.documentSymbolProvider, 'document symbol capability');
    assert.ok(caps.definitionProvider, 'go-to-definition capability');
    assert.ok(caps.referencesProvider, 'find-references capability');
    client.notify('initialized', {});

    // ── diagnostics: broken module ─────────────────────────────────────────
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: BAD },
    });
    const badDiags = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.some((d: any) => d.severity === 1)
    );
    const badMessages = badDiags.diagnostics.map((d: any) => d.message);
    assert.ok(
      badMessages.some((m: string) => /missing its closing 'END MODULE'/.test(m)),
      `expected missing-END-MODULE error, got: ${JSON.stringify(badMessages)}`
    );
    assert.ok(
      badMessages.some((m: string) => /Variable 'myVar'/.test(m)),
      'expected undeclared-variable warning'
    );

    // ── diagnostics: fixed module -> clean ─────────────────────────────────
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: FIXED }],
    });
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.length === 0
    );

    // ── completion ─────────────────────────────────────────────────────────
    const comp = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 7, character: 6 }, // after `SET Out...` prefix "O" on JSON.Data line
    });
    const compLabels: string[] = (comp.result ?? comp).map((i: any) => i.label);
    // Position is mid-word on `SET OutputRoot.JSON.Data.msg = myVar;`
    // -> general context filtered by the word being typed.
    assert.ok(compLabels.length > 0, 'completion returned items');

    // A position *inside* `Main`'s body: the full list, with the file's own
    // declared names among it.
    const comp2 = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 8, character: 0 }, // start of the PROPAGATE line, empty prefix
    });
    const labels2: string[] = (comp2.result ?? comp2).map((i: any) => i.label);
    assert.ok(labels2.includes('CAST'), 'offers built-in functions');
    assert.ok(labels2.includes('PROPAGATE'), 'offers keywords');
    assert.ok(labels2.includes('module-compute'), 'offers snippets');
    assert.ok(labels2.includes('myVar'), 'offers the variable declared in this routine');
    // CODE_REVIEW.md C-4: this client never declared snippetSupport, so the
    // body must arrive as de-placeholdered PlainText, not raw `${1:…}`.
    const snipItem = (comp2.result ?? comp2).find((i: any) => i.label === 'module-compute');
    assert.equal(snipItem.insertTextFormat, 1, 'PlainText when snippets are not declared');
    assert.ok(!/\$\d|\$\{/.test(snipItem.insertText), 'no placeholder syntax for a non-snippet client');
    assert.match(snipItem.insertText, /BROKER SCHEMA com\.example\.integrations/, 'placeholder text keeps its default value');
    assert.equal(
      new Set(labels2).size,
      labels2.length,
      `no label twice in one list (got ${labels2.length} items, ${new Set(labels2).size} labels) — I-17`
    );

    // ISSUES.md I-16: the same request from outside every routine must not carry
    // that routine's declarations any more.
    const comp3 = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 12, character: 0 }, // empty line after END MODULE
    });
    const labels3: string[] = (comp3.result ?? comp3).map((i: any) => i.label);
    assert.ok(labels3.includes('CAST'), 'the static part of the list is unaffected');
    assert.ok(
      !labels3.includes('myVar'),
      'a name declared inside Main() is not offered past END MODULE — I-16'
    );

    // ── document symbols ───────────────────────────────────────────────────
    const syms = await client.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    const moduleSym = (syms.result ?? syms).find(
      (s: any) => s.name === 'TestModule'
    );
    assert.ok(moduleSym, 'module symbol present');
    const fnNames = (moduleSym.children ?? []).map((c: any) => c.name);
    assert.ok(fnNames.includes('Main'), 'Main() nested under module');

    // ── hover ──────────────────────────────────────────────────────────────
    // Line 4: `SET OutputRoot.Properties = InputRoot.Properties;`
    // character 30 is inside `InputRoot` (a message tree variable).
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 4, character: 30 },
    });
    assert.ok(hover.result, 'hover for message tree variable');
    const contents: any = hover.result.contents;
    const text = Array.isArray(contents)
      ? contents[0].value
      : typeof contents === 'string'
        ? contents
        : contents.value;
    assert.match(text, /message tree variable/);

    // ── hover on the user's own variable ───────────────────────────────────
    // FIXED line 5 declares myVar; lines 6 and 7 use it.
    const fixedLines = FIXED.split('\n');
    const useCol = fixedLines[6].indexOf('myVar');
    const hoverVar = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 6, character: useCol + 1 },
    });
    assert.match(hoverVar.result.contents.value, /### `myVar`/);
    assert.match(hoverVar.result.contents.value, /Declared variable.*CHARACTER/);

    // ── go to definition + find references ─────────────────────────────────
    const declCol = fixedLines[5].indexOf('myVar');
    const def = await client.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: 6, character: useCol + 1 },
    });
    assert.deepEqual(def.result, [
      {
        uri,
        range: {
          start: { line: 5, character: declCol },
          end: { line: 5, character: declCol + 'myVar'.length },
        },
      },
    ]);

    const refs = await client.request('textDocument/references', {
      textDocument: { uri },
      position: { line: 6, character: useCol + 1 },
      context: { includeDeclaration: true },
    });
    assert.deepEqual(
      (refs.result ?? []).map((l: any) => l.range.start.line),
      [5, 6, 7],
      'the DECLARE plus both uses'
    );

    const refsNoDecl = await client.request('textDocument/references', {
      textDocument: { uri },
      position: { line: 6, character: useCol + 1 },
      context: { includeDeclaration: false },
    });
    assert.deepEqual(
      (refsNoDecl.result ?? []).map((l: any) => l.range.start.line),
      [6, 7],
      'includeDeclaration: false drops the DECLARE'
    );

    // ── go to definition for a routine, from its own header ────────────────
    const routineDef = await client.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: 2, character: fixedLines[2].indexOf('Main') + 1 },
    });
    assert.equal(routineDef.result[0].range.start.line, 2, 'Main is defined where it is created');

    // ── graceful shutdown ──────────────────────────────────────────────────
    const shutdown = await client.request('shutdown', null);
    assert.ok('result' in shutdown || 'error' in shutdown);
    client.notify('exit', undefined);
  } finally {
    await client.close();
  }
});

test('workspace/didChangeConfiguration re-validates with new settings', async () => {
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/Settings.esql';
  const SRC = [
    'CREATE COMPUTE MODULE SettingsModule',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "SET myVar = 'x';",
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});

    // Default settings: myVar is undeclared -> warning published.
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: SRC },
    });
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.some((d: any) => /Variable 'myVar'/.test(d.message))
    );

    // Runtime update: turn the undeclared-variables check off (section form).
    client.notify('workspace/didChangeConfiguration', {
      settings: { esql: { diagnostics: { checkUndeclaredVariables: false } } },
    });
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.every((d: any) => !/Variable 'myVar'/.test(d.message))
    );
  } finally {
    await client.close();
  }
});

test('a burst of didOpen publishes diagnostics for EVERY open document', async () => {
  // One shared debounce timer used to mean that within each 300 ms window only
  // the LAST scheduled URI was ever validated: restore a session, open a folder
  // or restart the server and every other tab stayed silent — including the two
  // bulk re-validate loops (initialized, grammar-ready), whose per-document
  // loop cancelled itself on each iteration (ISSUES.md I-1).
  const client = new LspClient();
  const text = (name: string) =>
    [
      `CREATE COMPUTE MODULE ${name}`,
      'CREATE FUNCTION Main() RETURNS BOOLEAN',
      'BEGIN',
      `SET ${name}Missing = 1;`,
      'RETURN TRUE;',
      'END;',
      'END MODULE;',
      '',
    ].join('\n');
  const uris = ['BurstA', 'BurstB', 'BurstC'].map((n) => `file:///tmp/esql-e2e/${n}.esql`);
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});

    // All three in the same tick — inside one debounce window.
    uris.forEach((uri, i) =>
      client.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'esql',
          version: 1,
          text: text(['BurstA', 'BurstB', 'BurstC'][i]),
        },
      })
    );

    for (const [i, uri] of uris.entries()) {
      const name = ['BurstA', 'BurstB', 'BurstC'][i];
      await client.waitFor(
        'textDocument/publishDiagnostics',
        (p) =>
          p.uri === uri &&
          p.diagnostics.some((d: any) => new RegExp(`Variable '${name}Missing'`).test(d.message)),
        8000
      );
    }

    // A settings change re-validates every document, not just one.
    client.notify('workspace/didChangeConfiguration', {
      settings: { esql: { diagnostics: { checkUndeclaredVariables: false } } },
    });
    for (const uri of uris) {
      await client.waitFor(
        'textDocument/publishDiagnostics',
        (p) => p.uri === uri && p.diagnostics.every((d: any) => !/never declared/.test(d.message)),
        8000
      );
    }
  } finally {
    await client.close();
  }
});

test('OutputRoot JSON hint over stdio: one per routine, and switchable', async () => {
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/JsonHint.esql';
  const SRC = [
    'CREATE COMPUTE MODULE JsonHintModule',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'DECLARE ccsid INTEGER InputRoot.Properties.CodedCharSetId;',
    'SET OutputRoot.JSON.Data.a = 1;',
    'SET OutputRoot.JSON.Data.b = 2;',
    'SET OutputRoot.JSON.Data.c = 3;',
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const isHint = (d: any) => /no copy of Properties/.test(d.message);
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: SRC },
    });

    // Three offending SETs, one hint — at the first of them.
    const published = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.some(isHint)
    );
    const hints = published.diagnostics.filter(isHint);
    assert.equal(hints.length, 1, 'one hint per routine');
    assert.equal(hints[0].range.start.line, 4, 'reported at the first offending SET');

    client.notify('workspace/didChangeConfiguration', {
      settings: { esql: { diagnostics: { checkOutputRootProperties: false } } },
    });
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.every((d: any) => !isHint(d))
    );
  } finally {
    await client.close();
  }
});
test('grammar-backed session: syntax errors and semantic tokens', async (t) => {
  if (!(await initGrammar())) {
    t.skip('tree-sitter addon unavailable — no grammar-backed diagnostics to assert');
    return;
  }
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/Grammar.esql';
  const BROKEN = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE GrammarModule',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  SET x = (1;',
    '  RETURN TRUE;',
    'END',
    'END MODULE;',
    '',
  ].join('\n');
  try {
    const init = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: {},
    });
    const legend: string[] = init.result.capabilities.semanticTokensProvider.legend.tokenTypes;
    assert.ok(legend.includes('keyword'), 'semantic tokens advertised');
    client.notify('initialized', {});

    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: BROKEN },
    });

    // Grammar init is async: wait for the grammar-backed error to arrive
    // (a heuristic-only publish would not contain it).
    const pub = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) =>
        p.uri === uri &&
        p.diagnostics.some(
          (d: any) => d.severity === 1 && /Syntax error|Missing syntax/.test(d.message)
        )
    );

    // E-10 over a real stdio session: the grammar inserted `)` to repair
    // `SET x = (1;` and the message names WHICH `(` needs closing (message
    // lines are 1-based for the human; the diagnostic's range stays 0-based).
    const paren = pub.diagnostics.find(
      (d: any) => d.code === 'syntax-error' && /Missing syntax/.test(d.message)
    );
    assert.ok(paren, JSON.stringify(pub.diagnostics.map((d: any) => d.message)));
    assert.equal(
      paren.message,
      "Missing syntax: expected ')' here — this '(' on line 5 is unclosed."
    );

    // The grammar is ready by now -> tokens must be non-empty.
    const tokens = await client.request('textDocument/semanticTokens/full', {
      textDocument: { uri },
    });
    const data = (tokens.result ?? tokens).data;
    assert.ok(Array.isArray(data), 'token data is an array');
    assert.ok(data.length > 0 && data.length % 5 === 0, 'relative quintuples');
  } finally {
    await client.close();
  }
});

/**
 * The degraded mode a machine without a C toolchain (or an `npm install
 * --ignore-scripts`) ends up in, forced with ESQL_LSP_NO_GRAMMAR=1: every
 * feature must still answer, only semantic tokens are grammar-specific.
 */
test('heuristic mode over stdio: diagnostics, symbols, definitions, hover', async () => {
  const client = new LspClient({ env: { ESQL_LSP_NO_GRAMMAR: '1' } });
  const uri = 'file:///tmp/esql-e2e/Heuristic.esql';
  try {
    const init = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } },
      initializationOptions: {},
    });
    const caps = init.result.capabilities;
    assert.ok(caps.definitionProvider, 'definitions advertised without the grammar');
    assert.ok(caps.referencesProvider, 'references advertised without the grammar');
    client.notify('initialized', {});

    // ── Phase 1 heuristics still find both problems in BAD ─────────────────
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: BAD },
    });
    const diags = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) =>
        p.uri === uri &&
        p.diagnostics.some((d: any) => /missing its closing 'END MODULE'/.test(d.message))
    );
    assert.ok(
      diags.diagnostics.some((d: any) => /Variable 'myVar'/.test(d.message)),
      'undeclared variable detected without a parse tree'
    );

    // ── semantic tokens are grammar-only: empty, never a crash ─────────────
    const tokens = await client.request('textDocument/semanticTokens/full', {
      textDocument: { uri },
    });
    assert.deepEqual((tokens.result ?? tokens).data, [], 'no semantic tokens without the grammar');

    // ── outline from the pattern fallback, in the shape this client declared ─
    // This client declared no `hierarchicalDocumentSymbolSupport`, which the
    // protocol defines as "the client reads SymbolInformation[]". Answering it
    // with the nested shape used to drop everything below module level, because
    // such a client ignores `children` (ISSUES.md I-22).
    const syms = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    const flat = syms.result ?? [];
    assert.ok(flat.some((s: any) => s.name === 'TestModule'), 'module symbol present');
    assert.ok(
      flat.some((s: any) => s.name === 'Main' && s.containerName === 'TestModule'),
      `Main() reports TestModule as its container: ${JSON.stringify(flat.map((s: any) => [s.name, s.containerName]))}`
    );
    assert.ok(
      flat.length === 3,
      `the nested Main becomes its own entry: ${JSON.stringify(flat.map((s: any) => [s.containerName, s.name]))}`
    );
    assert.equal(
      flat.every((s: any) => s.children === undefined && s.location?.uri === uri),
      true,
      'flat entries carry a location and no children field'
    );

    // ── user-symbol features on the pattern fallback ───────────────────────
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: FIXED }],
    });
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.length === 0
    );

    const useCol = FIXED.split('\n')[6].indexOf('myVar');
    const position = { line: 6, character: useCol + 1 };

    const def = await client.request('textDocument/definition', {
      textDocument: { uri },
      position,
    });
    assert.equal(def.result[0].range.start.line, 5, 'DECLARE line found without a tree');

    const refs = await client.request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    assert.deepEqual((refs.result ?? []).map((l: any) => l.range.start.line), [5, 6, 7]);

    const hover = await client.request('textDocument/hover', {
      textDocument: { uri },
      position,
    });
    assert.match(hover.result.contents.value, /### `myVar`/);
    // Owner line matches grammar mode: the innermost routine owns it. (I-15:
    // the fallback used to blame the first routine in the file.)
    assert.match(hover.result.contents.value, /\*in `Main\(\)`\*/);

    // ── completion, scope-filtered on the pattern fallback too (I-16/I-17) ──
    const inside = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 8, character: 0 }, // inside Main()
    });
    const insideLabels: string[] = (inside.result ?? inside).map((i: any) => i.label);
    assert.ok(insideLabels.includes('myVar'), 'declared name offered inside its routine');
    assert.equal(
      new Set(insideLabels).size,
      insideLabels.length,
      'no label twice in one list'
    );

    // C-4: this client DID declare snippetSupport, so snippet bodies come
    // back as real LSP snippets — the capability plumbing, measured in
    // heuristic mode (the flag path is mode-independent).
    const snip = (inside.result ?? inside).find((i: any) => i.label === 'module-compute');
    assert.equal(snip.insertTextFormat, 2, 'Snippet format when the capability is declared');
    assert.ok(snip.insertText.includes('${1:'), 'placeholder body passed through untouched');

    const outside = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 12, character: 0 }, // past END MODULE
    });
    const outsideLabels: string[] = (outside.result ?? outside).map((i: any) => i.label);
    assert.ok(outsideLabels.includes('CAST'), 'the static part is still there');
    assert.ok(!outsideLabels.includes('myVar'), 'but not the out-of-scope declared name');

    const shutdown = await client.request('shutdown', null);
    assert.ok('result' in shutdown);
    client.notify('exit', undefined);
  } finally {
    await client.close();
  }
});

/**
 * ISSUES.md I-14 — the server used to send `workspace/semanticTokens/refresh`
 * to every client and discard the promise, so the `-32601` answer from a client
 * that never declared the capability became an unhandled rejection and the
 * process exited 1 about 0.2 s after start, in grammar mode only.
 */
test('no refresh request is sent to a client that did not declare refreshSupport', async () => {
  const client = new LspClient({ onServerRequest: 'method-not-found' });
  try {
    const init = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {
        textDocument: { publishDiagnostics: {}, semanticTokens: { requests: { full: true } } },
      },
      initializationOptions: {},
    });
    assert.equal(
      init.result.capabilities.workspace?.semanticTokens?.refreshSupport,
      false,
      'the server must not advertise a refresh it may not send'
    );
    client.notify('initialized', {});

    // Give the grammar time to load — that is the moment the request used to fire.
    const uri = 'file:///tmp/esql-e2e/RefreshGate.esql';
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: FIXED },
    });
    await client.waitFor('textDocument/publishDiagnostics', (p) => p.uri === uri);
    await new Promise((r) => setTimeout(r, 1500));

    assert.deepEqual(client.serverRequests, [], 'no server→client request at all');
    assert.equal(client.exited, null, 'server still running');
    const syms = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    assert.ok((syms.result ?? []).length > 0, 'and it still answers requests');
  } finally {
    await client.close();
  }
});

test('a client that answers the refresh request with MethodNotFound does not kill the server', async (t) => {
  if (!(await skipWithoutGrammar(t))) return; // the refresh is sent only once the grammar lands
  const client = new LspClient({ onServerRequest: 'method-not-found' });
  const uri = 'file:///tmp/esql-e2e/RefreshDeclined.esql';
  try {
    const init = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {
        textDocument: { documentSymbol: {}, semanticTokens: { requests: { full: true } } },
        workspace: { semanticTokens: { refreshSupport: true } },
      },
      initializationOptions: {},
    });
    assert.equal(
      init.result.capabilities.workspace?.semanticTokens?.refreshSupport,
      true,
      'advertised back when the client declares it'
    );
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: FIXED },
    });

    await client.waitForServerRequest('workspace/semanticTokens/refresh');
    assert.deepEqual(client.serverRequests, ['workspace/semanticTokens/refresh']);
    await new Promise((r) => setTimeout(r, 500)); // let the -32601 reply land
    assert.equal(client.exited, null, 'the declined refresh must not end the process');

    const syms = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    assert.ok((syms.result ?? []).length > 0, 'requests after the declined refresh still answered');
  } finally {
    await client.close();
  }
});

/**
 * ISSUES.md I-22.3 — `{ esql: { … } }` is documented as an accepted shape for
 * both configuration paths; it used to work only in didChangeConfiguration.
 */
test('initializationOptions accepts the { esql: … } section wrapper too', async () => {
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/WrappedSettings.esql';
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: { textDocument: { publishDiagnostics: {} } },
      initializationOptions: { esql: { diagnostics: { checkUndeclaredVariables: false } } },
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: BAD },
    });
    const diags = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.length > 0
    );
    const messages = diags.diagnostics.map((d: any) => d.message);
    assert.ok(
      !messages.some((m: string) => /Variable 'myVar'/.test(m)),
      `the wrapped switch must silence the undeclared-variable check, got ${JSON.stringify(messages)}`
    );
    assert.ok(
      messages.some((m: string) => /END MODULE/.test(m)),
      'the other checks keep their defaults (one key does not disable the rest)'
    );
  } finally {
    await client.close();
  }
});

/**
 * I-21: every diagnostic names its source and carries a code, over a real stdio
 * session. The code is what a user suppresses one check with, so it has to
 * survive the wire — and turning a check off has to take its code with it.
 */
test('every diagnostic over the wire carries source and code', async () => {
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/Codes.esql';
  const SRC = [
    'CREATE COMPUTE MODULE CodesModule',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'DECLARE ccsid INTEGER InputRoot.Properties.CodedCharSetId;',
    'SET OutputRoot.JSON.Data.a = 1;',
    'SET nowhere = ccsid;',
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const KNOWN = [
    'syntax-error',
    'module-no-main',
    'missing-end-module',
    'undeclared-variable',
    'undeclared-read',
    'no-propagation',
    'unclosed-main',
    'deprecated-parser',
    'deprecated-type',
    'unknown-routine',
    'missing-semicolon',
    'output-root-properties',
  ];
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: SRC },
    });
    const published = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) =>
        p.uri === uri &&
        p.diagnostics.some((d: any) => d.code === 'undeclared-variable') &&
        p.diagnostics.some((d: any) => d.code === 'output-root-properties')
    );
    for (const d of published.diagnostics) {
      assert.equal(d.source, 'esql', `\`${d.message}\` names its source`);
      assert.equal(typeof d.code, 'string', `\`${d.message}\` carries a code`);
      assert.ok(KNOWN.includes(d.code), `unknown diagnostic code ${JSON.stringify(d.code)}`);
    }

    // Switch one check off: its code leaves the published set, the others stay.
    client.notify('workspace/didChangeConfiguration', {
      settings: { esql: { diagnostics: { checkOutputRootProperties: false } } },
    });
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.every((d: any) => d.code !== 'output-root-properties')
    );
    const after = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 4, character: 5 },
    });
    assert.equal(after.error, undefined, 'the session is healthy after the settings change');
  } finally {
    await client.close();
  }
});

/**
 * E-3 over a real stdio session: a legacy `LOGICAL` file gets its
 * modernization hint and its own setting toggle silences exactly that
 * check. No skipWithoutGrammar guard on purpose — the hint is a flat check
 * and fires identically on both paths; the measured defect was grammar mode
 * FALSE-FLAGGING what its own fallback silently accepted, so the no-addon
 * run of this test is just as meaningful as the grammar one.
 */
test('legacy LOGICAL: hint over stdio, silenced by its own setting (E-3)', async (t) => {
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/LogicalE3.esql';
  const src = [
    'CREATE COMPUTE MODULE LegacyTypes',
    '    CREATE FUNCTION Main() RETURNS BOOLEAN',
    '    BEGIN',
    '        DECLARE flag LOGICAL;',
    '        SET flag = TRUE;',
    '        RETURN TRUE;',
    '    END;',
    'END MODULE;',
    '',
  ].join('\n');
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: src },
    });
    const first = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.some((d: any) => d.code === 'deprecated-type')
    );
    const hint = first.diagnostics.find((d: any) => d.code === 'deprecated-type');
    assert.equal(hint.severity, 4, 'Hint severity (LSP: 1 error, 2 warning, 3 info, 4 hint)');
    assert.equal(hint.range.start.line, 3);
    assert.equal(hint.range.start.character, 21, 'underlines the type word itself');
    assert.ok(
      !first.diagnostics.some((d: any) => d.code === 'syntax-error'),
      'a clean legacy file is not damage — pre-E-3 grammar mode said otherwise'
    );
    // Silence exactly this check…
    client.notify('workspace/didChangeConfiguration', {
      settings: { esql: { diagnostics: { checkDeprecatedTypes: false } } },
    });
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.every((d: any) => d.code !== 'deprecated-type')
    );
    // …without disturbing the session.
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 3, character: 17 },
    });
    assert.match(hover.result?.contents?.value ?? '', /flag/, 'healthy session after the settings change');
  } finally {
    await client.close();
  }
});

/**
 * E-5 over a real stdio session: the read warning ships with its code and
 * severity, and its own setting toggle removes exactly that code while the
 * WRITE check's finding on the neighboring line survives — the E-5
 * write/read split has to stay switchable apart. No skip guard: the flat
 * half must behave identically for users without a C toolchain, and the
 * fixture is clean ESQL in both modes.
 */
test('undeclared read over stdio, toggled off without touching the write check (E-5)', async () => {
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/ReadsE5.esql';
  const src = [
    'CREATE COMPUTE MODULE ReadsE5E2E',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  DECLARE total INTEGER;',
    '  SET total = Undeclared + 1;',
    '  SET nowhere = 1;',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: src },
    });
    const first = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) =>
        p.uri === uri &&
        p.diagnostics.some((d: any) => d.code === 'undeclared-read') &&
        p.diagnostics.some((d: any) => d.code === 'undeclared-variable'),
      15000
    );
    const read = first.diagnostics.find((d: any) => d.code === 'undeclared-read');
    assert.equal(read.severity, 2, 'Warning');
    assert.equal(read.range.start.line, 4, 'the read line, not the write line');
    assert.equal(read.range.start.character, 14, 'underlines the name itself');
    assert.match(read.message, /Undeclared.*read here but never declared/);
    const write = first.diagnostics.find((d: any) => d.code === 'undeclared-variable');
    assert.match(write.message, /nowhere.*assigned here but never declared/, 'the reworded write message ships');
    // Silence ONLY the read half…
    client.notify('workspace/didChangeConfiguration', {
      settings: { esql: { diagnostics: { checkUndeclaredReads: false } } },
    });
    const second = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) =>
        p.uri === uri &&
        p.diagnostics.every((d: any) => d.code !== 'undeclared-read') &&
        p.diagnostics.some((d: any) => d.code === 'undeclared-variable')
    );
    assert.ok(second, 'the write finding survives the read toggle');
    // …and the session stays healthy.
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 3, character: 12 },
    });
    assert.match(hover.result?.contents?.value ?? '', /total/, 'healthy session after the settings change');
  } finally {
    await client.close();
  }
});

/**
 * E-4 over a real stdio session with a real workspace directory: after the
 * post-`initialized` scan, the sibling file's routine resolves, the unknown
 * CALL targets stay warned, and the typo one carries the sibling's name as
 * its did-you-mean — proving suggestions come from the index, not just the
 * open buffer. No skip guard: the check is a flat pass plus server wiring,
 * due identically in both modes.
 */
test('unknown CALL targets are checked against the workspace over stdio (E-4)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-e4-e2e-'));
  const libPath = path.join(dir, 'Helpers.esql');
  const mainPath = path.join(dir, 'Main.esql');
  const mainUri = pathToFileURL(mainPath).href;
  const MAIN = [
    'BROKER SCHEMA com.test.e4;',
    'CREATE COMPUTE MODULE Caller',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  DECLARE x INTEGER;',
    '  SET x = Helper(1);',
    '  CALL DoesNotExist(2);',
    '  CALL Helpr();',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(
      libPath,
      ['CREATE FUNCTION Helper(p INTEGER) RETURNS INTEGER', 'BEGIN RETURN p; END;', ''].join('\n')
    );
    fs.writeFileSync(mainPath, MAIN);
    const client = new LspClient();
    try {
      await client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(dir).href,
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'e4' }],
        capabilities: {},
        initializationOptions: {},
      });
      client.notify('initialized', {});
      client.notify('textDocument/didOpen', {
        textDocument: { uri: mainUri, languageId: 'esql', version: 1, text: MAIN },
      });
      // Pre-scan publishes may still call the sibling unknown; the post-scan
      // state is exactly the two unknowns, the typo pointing at 'Helper'.
      const published = await client.waitFor(
        'textDocument/publishDiagnostics',
        (p: any) =>
          p.uri === mainUri &&
          p.diagnostics.filter((d: any) => d.code === 'unknown-routine').length === 2 &&
          p.diagnostics.some((d: any) => /^Routine 'DoesNotExist'/.test(d.message)) &&
          p.diagnostics.some((d: any) => /Did you mean 'Helper'\?/.test(d.message)),
        15000
      );
      const typo = published.diagnostics.find((d: any) => /Helpr/.test(d.message));
      assert.equal(typo.severity, 2, 'Warning');
      assert.equal(typo.range.start.line, 7, 'the CALL Helpr line');
      // Toggle off: exactly this code leaves, the session stays usable.
      client.notify('workspace/didChangeConfiguration', {
        settings: { esql: { diagnostics: { checkUnknownRoutines: false } } },
      });
      await client.waitFor(
        'textDocument/publishDiagnostics',
        (p: any) => p.uri === mainUri && p.diagnostics.every((d: any) => d.code !== 'unknown-routine')
      );
      const syms = await client.request('workspace/symbol', { query: 'DoesNotExist' });
      assert.deepEqual(syms.result, [], 'and the index really does not know the name');
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * E-4's overflow guard end to end: a 300 KB sibling trips the index's
 * size limit, `skipped > 0` silences the check — a routine could be declared
 * in the unread file, so even a definitely-unknown target goes unreported.
 * Pre-scan publishes DO warn (nothing skipped yet), so a permanently quiet
 * unknown-routine code can only come from the guard.
 */
test('a skipped index file silences the routine check — silence beats a false flag (E-4)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-e4-ovf-'));
  const mainPath = path.join(dir, 'Main.esql');
  const mainUri = pathToFileURL(mainPath).href;
  const MAIN = [
    'CREATE COMPUTE MODULE Caller',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  CALL DoesNotExist(1);',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(
      path.join(dir, 'Oversized.esql'),
      '-- padding past MAX_FILE_BYTES\nDECLARE big INTEGER;\n' + 'A'.repeat(300 * 1024)
    );
    fs.writeFileSync(mainPath, MAIN);
    const client = new LspClient();
    try {
      await client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(dir).href,
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'e4-ovf' }],
        capabilities: {},
        initializationOptions: {},
      });
      client.notify('initialized', {});
      client.notify('textDocument/didOpen', {
        textDocument: { uri: mainUri, languageId: 'esql', version: 1, text: MAIN },
      });
      const published = await client.waitFor(
        'textDocument/publishDiagnostics',
        (p: any) => p.uri === mainUri && p.diagnostics.every((d: any) => d.code !== 'unknown-routine'),
        15000
      );
      // The check that needs the index went quiet; a clean module then simply
      // reports nothing — and nothing else, either (source field proves the
      // publish is the server's, not a stray).
      assert.ok(published.diagnostics.every((d: any) => d.source === 'esql'));
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * I-22: malformed requests. A client that sends `{}` (a proxy, a replay, a
 * plugin with a bug) used to get `-32603 InternalError` quoting V8 — "Cannot
 * read properties of undefined (reading 'uri')" — which some editors show the
 * user. The protocol has InvalidParams for exactly this, and a position that
 * merely fell off the end of the buffer is not an error at all: it is "nothing
 * there".
 */
test('malformed requests answer InvalidParams, positions off the end answer nothing', async () => {
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/Malformed.esql';
  const SRC = [
    'CREATE COMPUTE MODULE MalformedModule',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'DECLARE myVar CHARACTER;',
    "SET myVar = 'hello';",
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: SRC },
    });
    await client.waitFor('textDocument/publishDiagnostics', (p) => p.uri === uri);

    const broken: Array<[string, unknown, string]> = [
      ['textDocument/hover', undefined, 'no params at all'],
      ['textDocument/hover', { position: { line: 3, character: 8 } }, 'no textDocument'],
      ['textDocument/hover', { textDocument: {}, position: { line: 3, character: 8 } }, 'no uri'],
      ['textDocument/hover', { textDocument: { uri } }, 'no position'],
      ['textDocument/hover', { textDocument: { uri }, position: { line: '3', character: 8 } }, 'line as a string'],
      ['textDocument/hover', { textDocument: { uri }, position: { line: -2, character: 0 } }, 'negative line'],
      ['textDocument/hover', { textDocument: { uri }, position: { line: 3 } }, 'half a position'],
      ['textDocument/completion', { textDocument: { uri }, position: null }, 'null position'],
      ['textDocument/definition', { textDocument: { uri } }, 'definition without a position'],
      ['textDocument/references', { textDocument: { uri }, position: { line: 1.5, character: 0 } }, 'fractional line'],
      ['textDocument/documentSymbol', { textDocument: {} }, 'symbols without a uri'],
      ['textDocument/semanticTokens/full', {}, 'tokens without a document'],
    ];
    for (const [method, params, what] of broken) {
      const reply = await client.request(method, params);
      assert.equal(
        reply.error?.code,
        -32602,
        `${method} with ${what} answered ${JSON.stringify(reply).slice(0, 180)}; expected -32602 InvalidParams`
      );
      assert.equal(reply.result, undefined, `${method} with ${what} answered both an error and a result`);
      // The message reaches a human in some editors: no V8 vocabulary in it.
      assert.doesNotMatch(
        String(reply.error.message),
        /Cannot read propert|is not a function|TypeError|reading '/,
        `${method} with ${what} leaked internals: ${reply.error.message}`
      );
    }

    // A position past the end of the buffer is a client whose text moved under
    // the request. That is "nothing there", not an error.
    const beyond = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 9999, character: 0 },
    });
    assert.equal(beyond.result, null, 'a line the document does not have holds nothing');
    assert.equal(beyond.error, undefined, 'and it is not reported as an error');
    const pastEnd = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 4, character: 9999 },
    });
    assert.deepEqual(pastEnd.result, [], 'a column past the end of the line offers nothing');

    // Last, the point of all of it: still alive, and still correct.
    assert.equal(client.exited, null, 'the server survived the whole battery');
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 3, character: 10 },
    });
    assert.match(hover.result?.contents?.value ?? '', /myVar/, 'and it still hovers');
  } finally {
    await client.close();
  }
});

/**
 * ISSUES.md I-6 plus CODE_REVIEW.md E-2b/E-7 over a real stdio session: a
 * file with garbage above an unclosed module — the worst state of a buffer
 * being typed. `syntax-error` only ever comes from the tree path, so
 * waiting for it still proves the grammar took over this document; the
 * publish that carries it must then show what the task-11 work owes:
 * `neverDeclared` — a SET target INSIDE the text recovery swallowed — is
 * still flagged (E-2b mining is what makes that possible), and the
 * forgotten END MODULE is reported ONCE, in the structure check's
 * better-worded form, not twice with the grammar's own phrasing (E-7).
 */
test('grammar mode keeps semantic checks inside a damaged file (I-6, E-2b, E-7)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
    '%%% stray text above the module',
    'CREATE COMPUTE MODULE Case13',
    '    CREATE FUNCTION Main() RETURNS BOOLEAN',
    '    BEGIN',
    '        DECLARE declaredVar INTEGER;',
    '        SET declaredVar = 1;',
    '        SET neverDeclared = declaredVar;',
    '        SET OutputRoot = InptuRoot;',
    '',
  ].join('\n');
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/DamagedI6.esql';
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: { textDocument: { publishDiagnostics: {} } },
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: src },
    });

    const diags = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.some((d: any) => d.code === 'syntax-error')
    );
    const codes = diags.diagnostics.map((d: any) => d.code);
    assert.ok(
      codes.includes('undeclared-variable'),
      `mined SET target still reported inside the damage: ${JSON.stringify(diags.diagnostics.map((d: any) => [d.code, d.message]))}`
    );
    assert.ok(codes.includes('missing-end-module'), 'module structure check still fires too');
    const und = diags.diagnostics.find((d: any) => d.code === 'undeclared-variable');
    assert.equal(und.range.start.line, 6, 'exact line of the SET inside the ERROR region');
    assert.equal(
      und.codeDescription?.href,
      'https://github.com/nils-gg/esql-lsp#diagnostics',
      'codeDescription survives the real protocol (optional, but sent)'
    );
    // E-7: the grammar still sees the damaged module header, but its
    // `Syntax error in a module definition.` shares the root cause with
    // missing-end-module and loses the line to the better wording.
    const endModule = diags.diagnostics.filter((d: any) => /END MODULE/.test(d.message));
    assert.equal(endModule.length, 1, JSON.stringify(diags.diagnostics.map((d: any) => d.message)));
    assert.equal(
      endModule[0].range.start.line,
      1,
      'on the CREATE MODULE header line, naming the module'
    );
    assert.ok(
      !diags.diagnostics.some((d: any) => /Syntax error in a module definition\./.test(d.message)),
      'the suppressed phrasing must not survive to the wire'
    );
    // The surviving syntax-error is the garbage line's own quoted-token
    // message — suppression is targeted, not a blanket silence.
    const syntax = diags.diagnostics.find((d: any) => d.code === 'syntax-error');
    assert.match(syntax.message, /^Unexpected '%%%' here\./);
  } finally {
    await client.close();
  }
});

/**
 * CODE_REVIEW.md E-1/E-8 over a real stdio session: the two messages that
 * replaced the bare `Syntax error.` and the hint grammar mode used to lose,
 * read off a live publishDiagnostics. Grammar-only — both phrasings come off
 * the tree; heuristic mode keeps its own Hint (asserted in the units).
 */
test('grammar mode quotes the typo and names the missing semicolon (E-1, E-8)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE ELM',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  SETN broken = 1;',
    '  SET done = TRUE',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/Messages.esql';
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: { textDocument: { publishDiagnostics: {} } },
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: src },
    });
    const pub = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) =>
        p.uri === uri &&
        p.diagnostics.some((d: any) => /Did you mean/.test(d.message)) &&
        p.diagnostics.some((d: any) => /not terminated/.test(d.message))
    );
    assert.deepEqual(
      pub.diagnostics
        .filter((d: any) => d.code === 'syntax-error')
        .map((d: any) => d.message)
        .sort(),
      [
        "Statement is not terminated — expected ';' here.",
        "Unexpected 'SETN' here. Did you mean 'SET'?",
      ].sort()
    );
  } finally {
    await client.close();
  }
});

/**
 * ISSUES.md I-13 over a real stdio session — and deliberately NOT gated on
 * the grammar: the cross-file mechanism is the shared pattern extractor, so
 * the machine without a C toolchain must get the same behaviour. With a
 * workspace root, `DECLARE … SHARED` in a sibling file lands via the
 * post-`initialized` scan and the undeclared-variable finding on the open
 * file goes away; the second, root-less session must still report the same
 * text — the mechanism silenced false positives, not the check.
 */
test('the workspace scan silences sibling-SHARED false positives (I-13)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-i13-e2e-'));
  const declPath = path.join(dir, 'Receiver.esql');
  const usePath = path.join(dir, 'ReceiverExceptionHandler.esql');
  const useUri = pathToFileURL(usePath).href;
  const USE = [
    'BROKER SCHEMA com.test.re;',
    'CREATE COMPUTE MODULE ReceiverExceptionHandler',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  SET FailureCount = FailureCount + 1;',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(
      declPath,
      [
        'BROKER SCHEMA com.test.recv;',
        'CREATE COMPUTE MODULE Receiver',
        'CREATE FUNCTION Main() RETURNS BOOLEAN',
        'BEGIN',
        '  DECLARE FailureCount SHARED INTEGER 0;',
        '  SET FailureCount = 0;',
        '  RETURN TRUE;',
        'END;',
        'END MODULE;',
        '',
      ].join('\n')
    );
    fs.writeFileSync(usePath, USE);

    const client = new LspClient();
    try {
      const init = await client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(dir).href,
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'i13' }],
        capabilities: {},
        initializationOptions: {},
      });
      assert.equal(
        init.result.capabilities.workspaceSymbolProvider,
        true,
        'workspace/symbol advertised'
      );
      client.notify('initialized', {});
      client.notify('textDocument/didOpen', {
        textDocument: { uri: useUri, languageId: 'esql', version: 1, text: USE },
      });
      // An early publish MAY still carry the finding (scan racing the first
      // debounce); the publish that lands after the scan must not.
      await client.waitFor(
        'textDocument/publishDiagnostics',
        (p: any) =>
          p.uri === useUri &&
          p.diagnostics.every((d: any) => d.code !== 'undeclared-variable'),
        15000
      );

      // workspace/symbol answers over the scan + the open buffer.
      const syms = await client.request('workspace/symbol', { query: 'Receiver' });
      const module = (syms.result as any[]).find(
        (s) => s.name === 'Receiver' && s.kind === 2 /* SymbolKind.Module */
      );
      assert.ok(module, `sibling module listed: ${JSON.stringify(syms.result)}`);
      assert.ok(module.location.uri.endsWith('/Receiver.esql'), module.location.uri);
      const none = await client.request('workspace/symbol', { query: 'nothing-matches' });
      assert.deepEqual(none.result, [], 'query filters as a substring');

      // N-2 witness: the merge is live-first. Opening the DECLARING file with
      // unsaved text that DROPS the SHARED DECLARE must bring the finding
      // back on the using file — the open buffer supersedes the disk copy.
      const declUri = pathToFileURL(declPath).href;
      const DECL_WITHOUT = [
        'BROKER SCHEMA com.test.recv;',
        'CREATE COMPUTE MODULE Receiver',
        'CREATE FUNCTION Main() RETURNS BOOLEAN',
        'BEGIN',
        '  SET FailureCount = 0;',
        '  RETURN TRUE;',
        'END;',
        'END MODULE;',
        '',
      ].join('\n');
      client.notify('textDocument/didOpen', {
        textDocument: { uri: declUri, languageId: 'esql', version: 1, text: DECL_WITHOUT },
      });
      // Re-validate the using file against the new workspace view.
      client.notify('textDocument/didChange', {
        textDocument: { uri: useUri, version: 2 },
        contentChanges: [{ text: USE.replace('RETURN TRUE;', '-- touch\n  RETURN TRUE;') }],
      });
      const backAgain = await client.waitFor(
        'textDocument/publishDiagnostics',
        (p: any) =>
          p.uri === useUri &&
          p.diagnostics.some(
            (d: any) => d.code === 'undeclared-variable' && /FailureCount/.test(d.message)
          ),
        15000
      );
      assert.ok(backAgain, 'an unsaved removal of the sibling DECLARE counts');

      // And re-adding it (still unsaved) silences the finding again.
      client.notify('textDocument/didChange', {
        textDocument: { uri: declUri, version: 2 },
        contentChanges: [
          {
            text: DECL_WITHOUT.replace(
              'SET FailureCount = 0;',
              'DECLARE FailureCount SHARED INTEGER 0;\n  SET FailureCount = 0;'
            ),
          },
        ],
      });
      client.notify('textDocument/didChange', {
        textDocument: { uri: useUri, version: 3 },
        contentChanges: [
          { text: USE.replace('RETURN TRUE;', '-- touch again\n  RETURN TRUE;') },
        ],
      });
      await client.waitFor(
        'textDocument/publishDiagnostics',
        (p: any) =>
          p.uri === useUri &&
          p.diagnostics.every((d: any) => d.code !== 'undeclared-variable'),
        15000
      );
    } finally {
      await client.close();
    }

    // Control: same text, no workspace root ⇒ the check keeps its teeth.
    const control = new LspClient();
    try {
      await control.request('initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
        initializationOptions: {},
      });
      control.notify('initialized', {});
      control.notify('textDocument/didOpen', {
        textDocument: { uri: useUri, languageId: 'esql', version: 1, text: USE },
      });
      const flagged = await control.waitFor(
        'textDocument/publishDiagnostics',
        (p: any) =>
          p.uri === useUri &&
          p.diagnostics.some(
            (d: any) => d.code === 'undeclared-variable' && /FailureCount/.test(d.message)
          ),
        15000
      );
      assert.ok(flagged, 'undeclared check still fires without a workspace');
    } finally {
      await control.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * T-3 / G-1 / G-2 / G-3 over a real two-file workspace: definition from the
 * CALL jumps into the sibling, references on the SHARED name answer in BOTH
 * files (uses in the open buffer + declaration and uses in the disk-only
 * sibling), hover on the call target shows the signature. Deliberately not
 * gated on the grammar — the workspace index is pattern-extracted, so both
 * modes must deliver identical navigation; the NO_GRAMMAR suite run proves
 * the second half by executing this very test without the addon.
 */
test('cross-file definition, references and hover over stdio (G-1/G-2/G-3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-xnav-'));
  const helperPath = path.join(dir, 'helper.esql');
  const callerPath = path.join(dir, 'caller.esql');
  const helperUri = pathToFileURL(helperPath).href;
  const callerUri = pathToFileURL(callerPath).href;
  const HELPER = [
    'BROKER SCHEMA com.test.xnav;', //                0
    'CREATE COMPUTE MODULE HelperLib', //             1
    'DECLARE Counter SHARED INTEGER 0;', //           2  the SHARED declaration
    'CREATE FUNCTION Helper() RETURNS BOOLEAN', //    3  the call target
    'BEGIN', //                                       4
    '  SET Counter = Counter + 1;', //                5
    '  RETURN TRUE;', //                              6
    'END;', //                                        7
    'END MODULE;', //                                 8
    '',
  ].join('\n');
  const CALLER = [
    'BROKER SCHEMA com.test.xnav;', //                0
    'CREATE COMPUTE MODULE CallerFlow', //            1
    'CREATE FUNCTION Main() RETURNS BOOLEAN', //      2
    'BEGIN', //                                       3
    '  CALL Helper();', //                            4
    '  SET Counter = Counter + 2;', //                5
    '  RETURN TRUE;', //                              6
    'END;', //                                        7
    'END MODULE;', //                                 8
    '',
  ].join('\n');
  try {
    fs.writeFileSync(helperPath, HELPER);
    fs.writeFileSync(callerPath, CALLER);

    const client = new LspClient();
    try {
      await client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(dir).href,
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'xnav' }],
        capabilities: {},
        initializationOptions: {},
      });
      client.notify('initialized', {});
      client.notify('textDocument/didOpen', {
        textDocument: { uri: callerUri, languageId: 'esql', version: 1, text: CALLER },
      });
      // Scan-settled marker: the sibling SHARED name stops being undeclared.
      await client.waitFor(
        'textDocument/publishDiagnostics',
        (p: any) =>
          p.uri === callerUri &&
          p.diagnostics.every((d: any) => d.code !== 'undeclared-variable'),
        15000
      );

      // G-1: definition from CALL Helper() lands on the sibling's header.
      const def = await client.request('textDocument/definition', {
        textDocument: { uri: callerUri },
        position: { line: 4, character: 9 }, // on `Helper`
      });
      const defLocs = (def.result ?? []) as any[];
      assert.equal(defLocs.length, 1, `one location: ${JSON.stringify(defLocs)}`);
      assert.ok(defLocs[0].uri.endsWith('/helper.esql'), 'in the sibling file');
      assert.equal(defLocs[0].range.start.line, 3, 'on the CREATE FUNCTION line');

      // And from the SHARED variable use, into its declaration.
      const defVar = await client.request('textDocument/definition', {
        textDocument: { uri: callerUri },
        position: { line: 5, character: 8 }, // on `Counter`
      });
      const varLocs = (defVar.result ?? []) as any[];
      assert.equal(varLocs.length, 1, 'the SHARED declaration, nowhere else');
      assert.ok(varLocs[0].uri.endsWith('/helper.esql'));
      assert.equal(varLocs[0].range.start.line, 2);

      // G-3: references sweep both files — caller's two uses, helper's
      // declaration plus its two uses.
      const refs = await client.request('textDocument/references', {
        textDocument: { uri: callerUri },
        position: { line: 5, character: 8 },
        context: { includeDeclaration: true },
      });
      const refLocs = (refs.result ?? []) as any[];
      const onCaller = refLocs.filter((l) => l.uri === callerUri);
      const onHelper = refLocs.filter((l) => l.uri === helperUri);
      assert.equal(onCaller.length, 2, `caller uses: ${JSON.stringify(onCaller)}`);
      assert.equal(onHelper.length, 3, `helper decl + uses: ${JSON.stringify(onHelper)}`);
      assert.ok(
        onHelper.some((l) => l.range.start.line === 2 && l.range.start.character === 8),
        'the declaration itself is among them'
      );

      // includeDeclaration: false drops exactly the declaration.
      const uses = await client.request('textDocument/references', {
        textDocument: { uri: callerUri },
        position: { line: 5, character: 8 },
        context: { includeDeclaration: false },
      });
      const useLocs = (uses.result ?? []) as any[];
      assert.equal(useLocs.length, 4, 'the four uses, no declaration');
      assert.ok(!useLocs.some((l) => l.range.start.line === 2 && l.uri === helperUri));

      // G-2: hover on the call target — synthesized signature + provenance.
      const hov = await client.request('textDocument/hover', {
        textDocument: { uri: callerUri },
        position: { line: 4, character: 9 },
      });
      const hv = hov.result?.contents;
      const value = typeof hv === 'string' ? hv : hv?.value ?? '';
      assert.match(value, /FUNCTION Helper\(\) RETURNS BOOLEAN/, 'signature block');
      assert.match(value, /defined in helper\.esql/, 'cross-file provenance line');
      assert.match(value, /workspace/, 'the path taken is marked');

      // C-1/C-2: completion over the same two-file workspace. Half-type the
      // CALL and ask — the sibling routine answers, naming its file.
      const PARTIAL = CALLER.replace('  CALL Helper();', '  CALL Hel');
      client.notify('textDocument/didChange', {
        textDocument: { uri: callerUri, version: 2 },
        contentChanges: [{ text: PARTIAL }],
      });
      const comp = await client.request('textDocument/completion', {
        textDocument: { uri: callerUri },
        position: { line: 4, character: 10 }, // just after `Hel`
      });
      const items = (comp.result ?? []) as any[];
      const helperItem = items.find((i) => i.label === 'Helper');
      assert.ok(helperItem, `the sibling CALL target completes: ${items.map((i) => i.label).join(',')}`);
      assert.equal(helperItem.kind, 3, 'CompletionItemKind.Function');
      assert.match(helperItem.detail, /in helper\.esql/, 'the detail names the file');
      // C-3 contract over stdio: the server ships the whole context list and
      // says how to match/rank it; the client does the filtering.
      assert.equal(helperItem.filterText, 'Helper', 'matched on the bare name');
      assert.equal(helperItem.sortText, '1:Helper', 'ranked in the user-name group');
      assert.ok(
        items.some((i) => i.label === 'MODULE'),
        'non-matching built-ins ship too (' + items.length + ' items)'
      );

      // The unfiltered general list carries the file's own routine (signature
      // detail) and the sibling SHARED variable (declaring file in detail).
      const general = ((
        await client.request('textDocument/completion', {
          textDocument: { uri: callerUri },
          position: { line: 7, character: 0 }, // start of `END;` — empty prefix
        })
      ).result ?? []) as any[];
      const main = general.find((i) => i.label === 'Main');
      assert.ok(main, 'own routine listed');
      assert.match(main.detail, /FUNCTION Main\(\) RETURNS BOOLEAN/, 'with its signature');
      const counter = general.find((i) => i.label === 'Counter');
      assert.ok(counter, 'sibling SHARED variable listed');
      assert.match(counter.detail, /SHARED, declared in helper\.esql/, 'with its provenance');
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ── N-1a: prepareRename + same-file rename (CODE_REVIEW.md N-1) ────────────

/**
 * One file that exercises every rename answer there is: a body variable
 * (local, renameable), a quoted name (renameable, quotes preserved), a
 * routine parameter (renameable — ESQL calls are positional), a SHARED
 * variable (renameable ONLY without a workspace root), a sibling routine
 * (same), `Main()` (never — ACE calls it by name), and the three things a
 * text rename must not touch: the module name, the schema, the namespace
 * alias. Positions are load-bearing: the expectations below are literal.
 */
const RENAME_SRC = [
  'BROKER SCHEMA com.test;',                           //  0
  'CREATE COMPUTE MODULE RenameN1',                    //  1
  'CREATE FUNCTION Main() RETURNS BOOLEAN',            //  2
  'BEGIN',                                             //  3
  '  DECLARE total INTEGER;',                          //  4  decl, cursor 12
  '  DECLARE count INTEGER 0;',                        //  5  collision source
  '  DECLARE "my var" CHARACTER;',                     //  6  quoted, inner 11-17
  "  DECLARE tns NAMESPACE 'urn:x';",                  //  7  alias: never renameable
  '  DECLARE sharedTotal SHARED INTEGER;',             //  8
  '  SET count = total + count;',                      //  9  two reads
  '  SET OutputRoot.JSON.Data.msg = total;',           // 10  read, cursor 36
  '  SET OutputRoot.JSON.Data.v = "my var";',          // 11  quoted read
  '  SET sharedTotal = sharedTotal + 1;',              // 12  write + read
  '  RETURN TRUE;',                                    // 13
  'END;',                                              // 14
  'END MODULE;',                                       // 15
  '',                                                  // 16
  'CREATE FUNCTION Helper(p INTEGER) RETURNS INTEGER', // 17  routine 16-22, param 23
  'BEGIN RETURN p; END;',                              // 18
  '',
].join('\n');

/** One server answer, printed the way a test can read it. */
function renameShape(r: any): string | string[] {
  if (r.error) return 'ERR ' + r.error.message;
  const res = r.result;
  if (res?.changes)
    return (Object.values(res.changes as Record<string, any[]>).flat() as any[]).map(
      (e) => `${e.range.start.line}:${e.range.start.character}-${e.range.end.character}->${JSON.stringify(e.newText)}`
    );
  if (res?.range)
    return `prep ${res.range.start.line}:${res.range.start.character}-${res.range.end.character} ${JSON.stringify(res.placeholder)}`;
  return 'null';
}

/**
 * The whole rename conversation over a real stdio session. The server's own
 * grammar load is async, and rename answers are mode-independent BY
 * CONTRACT (both paths feed the same `referencesAt` engine), so both runs
 * assert the SAME literal expectations — whichever path a given request
 * happened to take. `npm run smoke:stdio -- --expect-grammar` is what pins
 * that a live session really runs the tree path.
 */
async function renameSession(env?: Record<string, string>) {
  const client = new LspClient(env ? { env } : {});
  const uri = 'file:///tmp/esql-e2e/RenameN1.esql';
  const prep = (line: number, character: number) =>
    client.request('textDocument/prepareRename', { textDocument: { uri }, position: { line, character } });
  const ren = (line: number, character: number, newName: string) =>
    client.request('textDocument/rename', { textDocument: { uri }, position: { line, character }, newName });
  try {
    const init = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      workspaceFolders: null,
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: RENAME_SRC },
    });
    return {
      capability: init.result?.capabilities?.renameProvider ?? 'missing',
      prepareDecl: renameShape(await prep(4, 12)),
      prepareRead: renameShape(await prep(10, 36)),
      prepareModule: renameShape(await prep(1, 24)),
      prepareSchema: renameShape(await prep(0, 20)),
      prepareAlias: renameShape(await prep(7, 12)),
      prepareParam: renameShape(await prep(17, 23)),
      renameParam: renameShape(await ren(17, 23, 'amount')),
      renameSum: renameShape(await ren(4, 12, 'sum')),
      renameCase: renameShape(await ren(4, 12, 'Total')),
      renameReserved: renameShape(await ren(4, 12, 'FROM')),
      renameSpaces: renameShape(await ren(4, 12, 'a b')),
      renameAliasCollision: renameShape(await ren(4, 12, 'tns')),
      renameOtherCollision: renameShape(await ren(4, 12, 'count')),
      quotedPrepare: renameShape(await prep(6, 13)),
      quotedRename: renameShape(await ren(6, 13, 'other name')),
      quotedBadQuote: renameShape(await ren(6, 13, 'a"b')),
      quotedToPlain: renameShape(await ren(6, 13, 'plain_name')),
      mainPrepare: renameShape(await prep(2, 17)),
      mainRename: renameShape(await ren(2, 17, 'Start')),
      sharedPrepare: renameShape(await prep(8, 12)),
      sharedRename: renameShape(await ren(8, 12, 'sharedBackup')),
      routinePrepare: renameShape(await prep(17, 18)),
      routineRename: renameShape(await ren(17, 18, 'Help2')),
      afterHover: (
        await client.request('textDocument/hover', {
          textDocument: { uri },
          position: { line: 4, character: 12 },
        })
      ).result?.contents?.value?.slice(0, 20),
    };
  } finally {
    await client.close();
  }
}

/** Recorded from a real session (see `renameSession`); every field is an
 * assertion in both modes, not a smoke test. */
const RENAME_EXPECTED = {
  capability: { prepareProvider: true },
  prepareDecl: 'prep 4:10-15 "total"',
  prepareRead: 'prep 10:33-38 "total"',
  prepareModule: 'null',
  prepareSchema: 'null',
  prepareAlias: 'null',
  prepareParam: 'prep 17:23-24 "p"',
  renameParam: [
    '17:23-24->"amount"',
    '18:13-14->"amount"',
  ],
  renameSum: [
    '4:10-15->"sum"',
    '9:14-19->"sum"',
    '10:33-38->"sum"',
  ],
  renameCase: [
    '4:10-15->"Total"',
    '9:14-19->"Total"',
    '10:33-38->"Total"',
  ],
  renameReserved: 'ERR esql-lsp: cannot rename to \'FROM\' — \'FROM\' is an ESQL reserved keyword — you cannot use it for a variable name',
  renameSpaces: 'ERR esql-lsp: cannot rename to \'a b\' — \'a b\' is not an ESQL identifier (letters, digits, underscore, not starting with a digit)',
  renameAliasCollision: 'ERR esql-lsp: cannot rename to \'tns\' — the file already has a name that reads the same (ESQL names are case-insensitive)',
  renameOtherCollision: 'ERR esql-lsp: cannot rename to \'count\' — the file already has a name that reads the same (ESQL names are case-insensitive)',
  quotedPrepare: 'prep 6:11-17 "my var"',
  quotedRename: [
    '6:11-17->"other name"',
    '11:32-38->"other name"',
  ],
  quotedBadQuote: 'ERR esql-lsp: cannot rename to \'a"b\' — a quoted name cannot contain a double quote (escape it as two double quotes)',
  quotedToPlain: [
    '6:11-17->"plain_name"',
    '11:32-38->"plain_name"',
  ],
  mainPrepare: 'ERR esql-lsp: cannot rename \'Main\' — ACE calls that routine by name in every compute module; renaming it makes the module unexecutable',
  mainRename: 'ERR esql-lsp: cannot rename \'Main\' — ACE calls that routine by name in every compute module; renaming it makes the module unexecutable',
  sharedPrepare: 'prep 8:10-21 "sharedTotal"',
  sharedRename: [
    '8:10-21->"sharedBackup"',
    '12:6-17->"sharedBackup"',
    '12:20-31->"sharedBackup"',
  ],
  routinePrepare: 'prep 17:16-22 "Helper"',
  routineRename: [
    '17:16-22->"Help2"',
  ],
  afterHover: '### `total`\n\n**Decla',
};

test('the fallback renames what find-references found, and refuses the rest (N-1a)', async () => {
  // No skip guard: this is the mode a machine without a C toolchain lives in,
  // and the answers below are the contract, not a degraded copy.
  assert.deepEqual(await renameSession({ ESQL_LSP_NO_GRAMMAR: '1' }), RENAME_EXPECTED);
});

test('grammar mode answers the same renames at the same positions (N-1a)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  assert.deepEqual(await renameSession(), RENAME_EXPECTED);
});

// ── N-1b + G-4: workspace-wide rename (task 16) ────────────────────────────

/**
 * One three-file ACE application: `flowA.esql` DECLAREs both SHARED variables
 * and is renamed FROM; `flowB.esql` is OPEN in the editor and its buffer
 * deliberately LACKS a line that is still on its disk (proving the live text
 * wins over the index snapshot); `flowC.esql` exists only on disk; `lib.esql`
 * (also open) holds the routine every flow CALLs. Positions are load-bearing:
 * the expectations below are recorded from a real session.
 */
const WS_A = [
  'BROKER SCHEMA com.test.wide;',                    // 0
  'CREATE COMPUTE MODULE FlowA',                     // 1
  'DECLARE Counter SHARED INTEGER 0;',               // 2  decl, cursor 10
  'DECLARE "shared name" SHARED CHARACTER;',         // 3  quoted decl, inner 9-20
  'CREATE FUNCTION Main() RETURNS BOOLEAN',          // 4
  'BEGIN',                                           // 5
  '  SET Counter = Counter + 1;',                    // 6
  '  SET "shared name" = \'a\';',                     // 7
  '  CALL Helper(2);',                               // 8
  '  RETURN TRUE;',                                  // 9
  'END;',                                            // 10
  'END MODULE;',                                     // 11
  '',                                                // 12
  'CREATE FUNCTION Local() RETURNS INTEGER',         // 13
  'BEGIN DECLARE loc INTEGER; SET loc = 1; RETURN loc; END;', // 14
  '',
].join('\n');
const WS_B_DISK = [
  'CREATE FUNCTION CallerB() RETURNS BOOLEAN',       // 0
  'BEGIN',                                           // 1
  '  SET Counter = Counter + 10;',                   // 2
  '  SET Counter = Counter + 20;',                   // 3  ONLY on disk — the buffer deleted it
  '  SET "shared name" = \'b\';',                     // 4
  '  CALL Helper(1);',                               // 5
  '  RETURN TRUE;',                                  // 6
  'END;',                                            // 7
  '',
].join('\n');
const WS_B_OPEN = [
  'CREATE FUNCTION CallerB() RETURNS BOOLEAN',       // 0
  'BEGIN',                                           // 1
  '  SET Counter = Counter + 10;',                   // 2
  '  SET "shared name" = \'b\';',                     // 3
  '  CALL Helper(1);',                               // 4
  '  RETURN TRUE;',                                  // 5
  'END;',                                            // 6
  '',
].join('\n');
const WS_C = [
  'CREATE FUNCTION CallerC() RETURNS BOOLEAN',       // 0
  'BEGIN',                                           // 1
  '  SET Counter = 3;',                              // 2
  '  SET "shared name" = \'c\';',                     // 3
  '  CALL Helper(3);',                               // 4
  '  RETURN TRUE;',                                  // 5
  'END;',                                            // 6
  '',
].join('\n');
const WS_LIB = [
  'CREATE FUNCTION Helper(p INTEGER) RETURNS INTEGER', // 0  routine name 16-22
  'BEGIN RETURN p; END;',                              // 1
  '',
].join('\n');

const baseName = (uri: string): string => uri.split('/').pop() as string;

/**
 * A workspace rename/ref answer, labelled by file whenever several files are
 * touched (the multi-file split is exactly where the cross-file wiring lives,
 * and which file an edit lands in is the assertion). documentChanges answers
 * keep their versions: the per-file version is part of the honesty.
 */
function wsShape(r: any): string | string[] | Record<string, any> {
  if (r.error) return 'ERR ' + r.error.message;
  const res = r.result;
  if (res?.documentChanges)
    return {
      kind: 'documentChanges',
      edits: res.documentChanges.flatMap((dc: any) =>
        dc.edits.map((e: any) =>
          `${baseName(dc.textDocument.uri)} ${dc.textDocument.version} ${e.range.start.line}:${e.range.start.character}-${e.range.end.character}->${JSON.stringify(e.newText)}`
        )
      ),
      annotations: Object.entries(res.changeAnnotations ?? {}).map(([id, a]: [string, any]) =>
        `${id} needs=${a.needsConfirmation} ${JSON.stringify(a.label)}`
      ),
      ids: res.documentChanges.map((dc: any) => JSON.stringify(dc.annotationIds ?? [])),
    };
  if (res?.changes) {
    const uris = Object.keys(res.changes);
    const multi = uris.length > 1;
    return uris.flatMap((u) =>
      res.changes[u].map(
        (e: any) =>
          (multi ? baseName(u) + ' ' : '') +
          `${e.range.start.line}:${e.range.start.character}-${e.range.end.character}->${JSON.stringify(e.newText)}`
      )
    );
  }
  if (res?.range)
    return `prep ${res.range.start.line}:${res.range.start.character}-${res.range.end.character} ${JSON.stringify(res.placeholder)}`;
  return 'null';
}

/** The whole rename conversation over the four-file workspace (open order is
 * load-bearing: it fixes the file order inside multi-file answers). */
async function wsRenameSession(env?: Record<string, string>, caps: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-n1b-'));
  const fileA = path.join(dir, 'flowA.esql');
  const fileB = path.join(dir, 'flowB.esql');
  const fileC = path.join(dir, 'flowC.esql');
  const fileL = path.join(dir, 'lib.esql');
  const uriA = pathToFileURL(fileA).href;
  const uriB = pathToFileURL(fileB).href;
  const uriL = pathToFileURL(fileL).href;
  const client = new LspClient(env ? { env } : {});
  try {
    fs.writeFileSync(fileA, WS_A);
    fs.writeFileSync(fileB, WS_B_DISK);
    fs.writeFileSync(fileC, WS_C);
    fs.writeFileSync(fileL, WS_LIB);
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'n1b' }],
      capabilities: caps,
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri: uriA, languageId: 'esql', version: 1, text: WS_A },
    });
    client.notify('textDocument/didOpen', {
      textDocument: { uri: uriB, languageId: 'esql', version: 3, text: WS_B_OPEN },
    });
    client.notify('textDocument/didOpen', {
      textDocument: { uri: uriL, languageId: 'esql', version: 7, text: WS_LIB },
    });
    await client.waitFor('textDocument/publishDiagnostics', (p: any) => p.uri === uriB, 15000);
    const ren = (uri: string, line: number, ch: number, newName: string) =>
      client.request('textDocument/rename', {
        textDocument: { uri },
        position: { line, character: ch },
        newName,
      });
    const prep = (uri: string, line: number, ch: number) =>
      client.request('textDocument/prepareRename', {
        textDocument: { uri },
        position: { line, character: ch },
      });
    const refs = async (uri: string, line: number, ch: number) => {
      const r = await client.request('textDocument/references', {
        textDocument: { uri },
        position: { line, character: ch },
        context: { includeDeclaration: true },
      });
      return ((r.result ?? []) as any[]).map(
        (l) => `${baseName(l.uri)} ${l.range.start.line}:${l.range.start.character}`
      );
    };
    return {
      // Task 15 refused these with a root; N-1b renames them across the workspace.
      prepareShared: wsShape(await prep(uriA, 2, 10)),
      sharedRename: wsShape(await ren(uriA, 2, 10, 'Total')),
      quotedSharedRename: wsShape(await ren(uriA, 3, 13, 'renamed one')),
      routineRename: wsShape(await ren(uriL, 0, 18, 'ComputeTwo')),
      mainRename: wsShape(await ren(uriA, 4, 17, 'Start')),
      localRename: wsShape(await ren(uriA, 14, 15, 'memo')),
      // G-4's references half: from the DECLARING file, the sibling uses are
      // listed too (the old engine only visited files that declared the name).
      refsFromDecl: await refs(uriA, 2, 10),
      refsRoutineFromDecl: await refs(uriL, 0, 18),
      scopeNotes: client.serverRequestCalls('window/showMessageRequest').map((p) => p.message),
    };
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Recorded from a real session; identical in both modes BY CONSTRUCTION —
 * the cross-file half is the pattern occurrence finder — so both runs assert
 * the same literal, and the fallback run carries no skip guard. */
const WS_RENAME_EXPECTED = {
  prepareShared: 'prep 2:8-15 "Counter"',
  sharedRename: [
    'flowA.esql 2:8-15->"Total"',
    'flowA.esql 6:6-13->"Total"',
    'flowA.esql 6:16-23->"Total"',
    'flowB.esql 2:6-13->"Total"',
    'flowB.esql 2:16-23->"Total"',
    'flowC.esql 2:6-13->"Total"',
  ],
  quotedSharedRename: [
    'flowA.esql 3:9-20->"renamed one"',
    'flowA.esql 7:7-18->"renamed one"',
    'flowB.esql 3:7-18->"renamed one"',
    'flowC.esql 3:7-18->"renamed one"',
  ],
  routineRename: [
    'lib.esql 0:16-22->"ComputeTwo"',
    'flowA.esql 8:7-13->"ComputeTwo"',
    'flowB.esql 4:7-13->"ComputeTwo"',
    'flowC.esql 4:7-13->"ComputeTwo"',
  ],
  mainRename:
    'ERR esql-lsp: cannot rename \'Main\' — ACE calls that routine by name in every compute module; renaming it makes the module unexecutable',
  localRename: ['14:14-17->"memo"', '14:31-34->"memo"', '14:47-50->"memo"'],
  refsFromDecl: [
    'flowA.esql 2:8',
    'flowA.esql 6:6',
    'flowA.esql 6:16',
    'flowB.esql 2:6',
    'flowB.esql 2:16',
    'flowC.esql 2:6',
  ],
  refsRoutineFromDecl: ['lib.esql 0:16', 'flowA.esql 8:7', 'flowB.esql 4:7', 'flowC.esql 4:7'],
  scopeNotes: [
    'esql-lsp: renamed \'Counter\' in 3 workspace files. ACE keeps SHARED variables visible application-wide — files outside this workspace may still use \'Counter\'.',
    'esql-lsp: renamed \'shared name\' in 3 workspace files. ACE keeps SHARED variables visible application-wide — files outside this workspace may still use \'shared name\'.',
    'esql-lsp: renamed \'Helper\' in 4 workspace files. The application may have files outside this workspace that still call \'Helper\'.',
  ],
};

test('the fallback renames SHARED names and routines across the workspace (N-1b/G-4)', async () => {
  // No skip guard: the cross-file scan is pattern-based, due in the mode a
  // machine without a C toolchain lives in.
  assert.deepEqual(await wsRenameSession({ ESQL_LSP_NO_GRAMMAR: '1' }), WS_RENAME_EXPECTED);
});

test('grammar mode renames the same files at the same positions (N-1b/G-4)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  assert.deepEqual(await wsRenameSession(), WS_RENAME_EXPECTED);
});

/**
 * The stale-snapshot guard with its own session: a disk-only file is rewritten
 * OUT OF BAND after the index settled (proved by the scan-dependent
 * unknown-routine diagnostic clearing on the marker buffer), and the rename
 * must edit the file's CURRENT text — ranges computed against the snapshot
 * would rewrite the wrong lines.
 */
test('a disk file changed after the scan is renamed from its fresh text (N-1b)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-n1b-stale-'));
  const fileA = path.join(dir, 'flowA.esql');
  const fileM = path.join(dir, 'marker.esql');
  const fileC = path.join(dir, 'flowC.esql');
  const fileL = path.join(dir, 'lib.esql');
  const uriA = pathToFileURL(fileA).href;
  const uriM = pathToFileURL(fileM).href;
  const client = new LspClient();
  try {
    fs.writeFileSync(fileA, WS_A);
    fs.writeFileSync(
      fileM,
      ['CREATE FUNCTION Marker() RETURNS BOOLEAN', 'BEGIN', '  CALL LibR();', '  RETURN TRUE;', 'END;', ''].join('\n')
    );
    fs.writeFileSync(
      fileL,
      ['CREATE FUNCTION LibR() RETURNS BOOLEAN', 'BEGIN RETURN TRUE; END;', ''].join('\n')
    );
    // v1: no Counter at all. The rename below must not trust this snapshot.
    fs.writeFileSync(
      fileC,
      ['CREATE FUNCTION CallerC() RETURNS BOOLEAN', 'BEGIN', '  SET other = 1;', '  RETURN TRUE;', 'END;', ''].join('\n')
    );
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'stale' }],
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    const markerText = [
      'CREATE FUNCTION Marker() RETURNS BOOLEAN',
      'BEGIN',
      '  CALL LibR();',
      '  RETURN TRUE;',
      'END;',
      '',
    ].join('\n');
    client.notify('textDocument/didOpen', {
      textDocument: { uri: uriM, languageId: 'esql', version: 1, text: markerText },
    });
    // Scan-settled marker: CALL LibR() stops being an unknown routine —
    // LibR lives only in a DISK file, so this can only flip when the scan ran.
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p: any) =>
        p.uri === uriM && p.diagnostics.every((d: any) => d.code !== 'unknown-routine'),
      15000
    );
    // Now the out-of-band change, after the snapshot exists.
    const v2 = [
      'CREATE FUNCTION CallerC() RETURNS BOOLEAN',
      'BEGIN',
      '  SET Counter = 3;',
      '  SET Counter = Counter + 77;',
      '  RETURN TRUE;',
      'END;',
      '',
    ].join('\n');
    fs.writeFileSync(fileC, v2);
    client.notify('textDocument/didOpen', {
      textDocument: { uri: uriA, languageId: 'esql', version: 1, text: WS_A },
    });
    const r = await client.request('textDocument/rename', {
      textDocument: { uri: uriA },
      position: { line: 2, character: 10 },
      newName: 'Total',
    });
    assert.deepEqual(wsShape(r), [
      'flowA.esql 2:8-15->"Total"',
      'flowA.esql 6:6-13->"Total"',
      'flowA.esql 6:16-23->"Total"',
      // The fresh-read lines. A rename computed against the snapshot would
      // carry NO flowC entries at all (v1 had no Counter); one computed
      // against v1 blindly would rewrite the wrong text.
      'flowC.esql 2:6-13->"Total"',
      'flowC.esql 3:6-13->"Total"',
      'flowC.esql 3:16-23->"Total"',
    ]);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The bounds rule: the index SKIPPED a file (here, over its size cap), so a
 * use of the name may hide in it — the workspace-wide rename REFUSES rather
 * than half-do the job, at prepare as well. A file-local rename in the same
 * session is untouched by the bounds: it never needed the scan.
 */
test('a workspace the scan skipped refuses the cross-file rename, prepare too (N-1b)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-n1b-bounds-'));
  const fileA = path.join(dir, 'flowA.esql');
  const uriA = pathToFileURL(fileA).href;
  const client = new LspClient();
  try {
    fs.writeFileSync(fileA, WS_A);
    fs.writeFileSync(path.join(dir, 'Big.esql'), '-- ' + 'x'.repeat(300 * 1024) + '\n'); // over the 256 KB cap
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'bounds' }],
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri: uriA, languageId: 'esql', version: 1, text: WS_A },
    });
    const boundErr =
      "ERR esql-lsp: cannot rename 'Counter' across the workspace — the bounded index scan " +
      'skipped 1 file(s) (beyond its 500-file / 256 KB limits), so a use of this name may ' +
      'live in a file rename cannot see. Rename inside those files yourself, or point the ' +
      'workspace at a smaller folder.';
    const ren = await client.request('textDocument/rename', {
      textDocument: { uri: uriA },
      position: { line: 2, character: 10 },
      newName: 'Total',
    });
    assert.equal(wsShape(ren), boundErr);
    const prep = await client.request('textDocument/prepareRename', {
      textDocument: { uri: uriA },
      position: { line: 2, character: 10 },
    });
    assert.equal(wsShape(prep), boundErr, 'prepare refuses too: the UI blocks before the user types');
    assert.deepEqual(
      wsShape(
        await client.request('textDocument/rename', {
          textDocument: { uri: uriA },
          position: { line: 14, character: 15 },
          newName: 'memo',
        })
      ),
      ['14:14-17->"memo"', '14:31-34->"memo"', '14:47-50->"memo"'],
      'the file-local half of rename is still fully available'
    );
    assert.deepEqual(
      client.serverRequestCalls('window/showMessageRequest'),
      [],
      'the refused rename sent no scope message'
    );
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A client that declared `documentChanges` gets the cross-file edit as
 * per-file TextDocumentEdits — with the live buffer's version, null for a
 * file the editor does not hold — each carrying the application-scope change
 * annotation (LSP 3.16) so the approximation surfaces in the client preview.
 * Without the declaration the same rename ships the `changes` map instead
 * (covered by wsRenameSession), and the scope note then travels solely in
 * the window/showMessage every client shows.
 */
test('a documentChanges client gets per-file edits with the scope annotation (N-1b)', async () => {
  const shape = await wsRenameSession(undefined, {
    workspace: { workspaceEdit: { documentChanges: true } },
  });
  assert.deepEqual((shape as any).sharedRename, {
    kind: 'documentChanges',
    edits: [
      'flowA.esql 1 2:8-15->"Total"',
      'flowA.esql 1 6:6-13->"Total"',
      'flowA.esql 1 6:16-23->"Total"',
      'flowB.esql 3 2:6-13->"Total"',
      'flowB.esql 3 2:16-23->"Total"',
      // version null: the editor holds no version of the disk-only file.
      'flowC.esql null 2:6-13->"Total"',
    ],
    annotations: [
      'esql-application-scope needs=false "esql-lsp: renamed \'Counter\' in 3 workspace files. ACE keeps SHARED variables visible application-wide — files outside this workspace may still use \'Counter\'."',
    ],
    ids: ['["esql-application-scope"]', '["esql-application-scope"]', '["esql-application-scope"]'],
  });
  // Routine + quoted renames annotate identically; the local one does not.
  assert.equal((shape as any).localRename.length, 3, 'local rename stays a plain changes map');
  assert.equal((shape as any).scopeNotes.length, 3, 'one scope note per cross-file rename');
});

/**
 * The task-15 safety rule, superseded: with a workspace root, SHARED names
 * and routines are no longer refused — the sibling that uses them is renamed
 * TOO. What survives: `Main()` (the name belongs to the platform), the
 * file-local rename exactly as recorded for task 15, and the workspace half
 * of the collision rule (a SHARED rename may not create an application-level
 * clash against a SIBLING's declaration the file-local check could not see).
 */
test('with a workspace root, the rename rewrites the sibling that uses the name (N-1b)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-n1b-rooted-'));
  const mainPath = path.join(dir, 'Main.esql');
  const mainUri = pathToFileURL(mainPath).href;
  const client = new LspClient();
  try {
    fs.writeFileSync(
      path.join(dir, 'Sibling.esql'),
      [
        'CREATE FUNCTION Caller() RETURNS BOOLEAN', //                   0
        'BEGIN',                                                      // 1
        '  SET sharedTotal = 1;',                                     // 2  use of the SHARED name
        '  CALL Helper(2);',                                          // 3  use of the routine
        '  RETURN TRUE;',                                             // 4
        'END;',                                                       // 5
        '',                                                           // 6
        'CREATE FUNCTION Other() RETURNS BOOLEAN',                    // 7
        'BEGIN',                                                      // 8
        '  DECLARE Counter SHARED INTEGER;',                          // 9  a SHARED name to collide with
        '  RETURN TRUE;',                                             // 10
        'END;',                                                       // 11
        '',
      ].join('\n')
    );
    fs.writeFileSync(mainPath, RENAME_SRC);
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'n1b' }],
      capabilities: {},
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri: mainUri, languageId: 'esql', version: 1, text: RENAME_SRC },
    });
    const ren = (line: number, character: number, newName: string) =>
      client.request('textDocument/rename', {
        textDocument: { uri: mainUri },
        position: { line, character },
        newName,
      });
    const prep = (line: number, character: number) =>
      client.request('textDocument/prepareRename', {
        textDocument: { uri: mainUri },
        position: { line, character },
      });

    assert.equal(wsShape(await prep(8, 12)), 'prep 8:10-21 "sharedTotal"', 'prepare now offers the SHARED name');
    assert.deepEqual(wsShape(await ren(8, 12, 'sharedBackup')), [
      'Main.esql 8:10-21->"sharedBackup"',
      'Main.esql 12:6-17->"sharedBackup"',
      'Main.esql 12:20-31->"sharedBackup"',
      'Sibling.esql 2:6-17->"sharedBackup"',
    ]);
    assert.deepEqual(wsShape(await ren(17, 18, 'Help2')), [
      'Main.esql 17:16-22->"Help2"',
      'Sibling.esql 3:7-13->"Help2"',
    ]);
    assert.match(
      wsShape(await ren(8, 12, 'Counter')) as string,
      /ERR .*cannot rename to 'Counter' — file:\/\/.*Sibling\.esql already declares a SHARED variable with that name/,
      'the workspace collision check protects the sibling SHARED name'
    );
    const mainErr = wsShape(await ren(2, 17, 'Start'));
    assert.ok(
      typeof mainErr === 'string' && /ERR .*cannot rename 'Main' — ACE calls that routine by name/.test(mainErr),
      `Main is still refused — the name comes from the platform (got ${JSON.stringify(mainErr)})`
    );
    assert.deepEqual(
      wsShape(await ren(4, 12, 'sum')),
      RENAME_EXPECTED.renameSum,
      'a file-local rename in the same session keeps the task-15 shape (plain changes map)'
    );
    const notes = client.serverRequestCalls('window/showMessageRequest').map((p) => p.message);
    assert.equal(notes.length, 2, 'one scope note per cross-file rename (the collision never renamed)');
    assert.ok(
      notes[0].includes("renamed 'sharedTotal' in 2 workspace files") &&
        notes[0].includes('application-wide'),
      `the SHARED note is honest about application scope (got ${JSON.stringify(notes[0])})`
    );
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ── E-9: code actions over stdio (task 17) ─────────────────────────────────

/**
 * One file carrying one diagnostic for every fix family that works without a
 * workspace: replace-a-word (parser + type), did-you-mean replacement plus
 * DECLARE skeleton (read), DECLARE skeleton (write), semicolons are owned by
 * the unit file (their over-stdio shape adds nothing the unit transform does
 * not already pin). The numbers below are RECORDS of real sessions (flat and
 * grammar answer them IDENTICALLY — asserted literally in both runs), not
 * hand-typed wishes.
 */
const CA_SRC = [
  'BROKER SCHEMA com.test;', //                          0
  'CREATE COMPUTE MODULE FixFlow', //                    1
  'DECLARE flag LOGICAL;', //                            2  deprecated-type
  'CREATE FUNCTION Main() RETURNS BOOLEAN', //           3
  'BEGIN', //                                            4  skeletons insert below
  '  DECLARE Counter INTEGER;', //                       5
  '  SET Counter = Countr + 1;', //                      6  undeclared-read
  '  SET x = InputRoot.XMLNS.Name;', //                  7  undeclared-variable + deprecated-parser
  '  RETURN TRUE;', //                                   8
  'END;', //                                             9
  'END MODULE;', //                                      10
  '',
].join('\n');

/** The server's answer for one codeAction request, condensed the same way
 * the rename tests condense WorkspaceEdits. */
function caShape(r: any): Array<Record<string, any>> {
  return (r.result ?? []).map((a: any) => ({
    title: a.title,
    kind: a.kind,
    edits: (a.edit?.changes?.[CA_URI] ?? []).map(
      (e: any) =>
        `${e.range.start.line}:${e.range.start.character}-${e.range.end.character}->${JSON.stringify(e.newText)}`
    ),
    pointsAt: (a.diagnostics ?? []).map((d: any) => d.code),
  }));
}

const CA_URI = 'file:///tmp/esql-e2e-t17/FixFlow.esql';

/** One full quick-fix conversation: capability, published codes, per-code
 * answers, a combined context, and the apply of the first read-fix followed
 * by the re-publish it earns. */
async function caSession(env?: Record<string, string>, options: any = {}) {
  const client = new LspClient(env ? { env } : {});
  try {
    const init = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: options,
    });
    const caCap = init.result.capabilities.codeActionProvider;
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri: CA_URI, languageId: 'esql', version: 1, text: CA_SRC },
    });
    const pub = await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === CA_URI && p.diagnostics.length > 0,
      15000
    );
    const byCode: Record<string, any[]> = {};
    for (const d of pub.diagnostics) (byCode[d.code] ??= []).push(d);
    const ask = (diags: any[]) =>
      client.request('textDocument/codeAction', {
        textDocument: { uri: CA_URI },
        range: diags[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { diagnostics: diags },
      });
    const codes = ['undeclared-read', 'deprecated-type', 'undeclared-variable', 'deprecated-parser'];
    const perCode: Record<string, any> = {};
    for (const code of codes) perCode[code] = caShape(await ask(byCode[code] ?? []));
    const combined = caShape(
      await ask(codes.map((c) => byCode[c]?.[0]).filter((d) => d !== undefined))
    );
    const out: any = {
      caCap,
      codes: pub.diagnostics.map((d: any) => d.code),
      perCode,
      combinedTitles: combined.map((a) => a.title),
    };
    // Apply the first undeclared-read fix for real: edits -> new text ->
    // didChange -> the re-publish must show the finding it fixed is gone.
    const readDiag = byCode['undeclared-read']?.[0];
    if (readDiag) {
      const first = (await ask([readDiag])).result[0];
      let fixed = CA_SRC;
      const offset = (pos: { line: number; character: number }) =>
        fixed.split('\n').slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.character;
      for (const e of first.edit.changes[CA_URI])
        fixed = fixed.slice(0, offset(e.range.start)) + e.newText + fixed.slice(offset(e.range.end));
      out.applied = fixed.split('\n')[6];
      client.notify('textDocument/didChange', {
        textDocument: { uri: CA_URI, version: 2 },
        contentChanges: [{ text: fixed }],
      });
      const after = await client.waitFor(
        'textDocument/publishDiagnostics',
        (p) => p.uri === CA_URI && p.diagnostics.every((d: any) => d.code !== 'undeclared-read'),
        15000
      );
      out.afterApplyCodes = after.diagnostics.map((d: any) => d.code);
    }
    return out;
  } finally {
    await client.close();
  }
}

/** Recorded from a real session (probe17); the grammar run answers the same. */
const CA_EXPECTED = {
  caCap: { codeActionKinds: ['quickfix'] },
  codes: ['undeclared-variable', 'undeclared-read', 'deprecated-parser', 'deprecated-type'],
  perCode: {
    'undeclared-read': [
      {
        title: "Use declared 'Counter'",
        kind: 'quickfix',
        edits: ['6:16-22->"Counter"'],
        pointsAt: ['undeclared-read'],
      },
      {
        title: "Declare 'Countr' as CHARACTER",
        kind: 'quickfix',
        edits: ['4:5-5->"\\n  DECLARE Countr CHARACTER;"'],
        pointsAt: ['undeclared-read'],
      },
    ],
    'deprecated-type': [
      {
        title: "Use 'BOOLEAN' instead of 'LOGICAL'",
        kind: 'quickfix',
        edits: ['2:13-20->"BOOLEAN"'],
        pointsAt: ['deprecated-type'],
      },
    ],
    'undeclared-variable': [
      {
        title: "Declare 'x' as CHARACTER",
        kind: 'quickfix',
        edits: ['4:5-5->"\\n  DECLARE x CHARACTER;"'],
        pointsAt: ['undeclared-variable'],
      },
    ],
    'deprecated-parser': [
      {
        title: "Use 'XMLNSC' instead of 'XMLNS'",
        kind: 'quickfix',
        edits: ['7:20-25->"XMLNSC"'],
        pointsAt: ['deprecated-parser'],
      },
    ],
  },
  combinedTitles: [
    "Use declared 'Counter'",
    "Declare 'Countr' as CHARACTER",
    "Use 'BOOLEAN' instead of 'LOGICAL'",
    "Declare 'x' as CHARACTER",
    "Use 'XMLNSC' instead of 'XMLNS'",
  ],
  applied: '  SET Counter = Counter + 1;',
  afterApplyCodes: ['undeclared-variable', 'deprecated-parser', 'deprecated-type'],
};

test('the fallback answers the full quick-fix contract over stdio (E-9)', async () => {
  // No skip guard: every fix in this fixture is the pattern path's answer.
  assert.deepEqual(await caSession({ ESQL_LSP_NO_GRAMMAR: '1' }), CA_EXPECTED);
});

test('grammar mode answers identical quick fixes (E-9)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  assert.deepEqual(await caSession(), CA_EXPECTED);
});

/**
 * The PLAN's toggle rule has TWO halves, both over stdio: a check that is
 * off publishes nothing (so a normal client never sees the fix), and an
 * echoed diagnostic of a switched-off check gets NO action — the fix obeys
 * the setting, not the echo. Untouched checks keep their fixes in the very
 * same session.
 */
test('switched-off checks hand out no fixes, even to an echo (E-9)', async () => {
  const s = await caSession(undefined, {
    diagnostics: { checkDeprecatedTypes: false, checkDeprecatedParsers: false },
  });
  assert.deepEqual(s.codes, ['undeclared-variable', 'undeclared-read'], 'the two checks went silent');
  assert.deepEqual(s.perCode['deprecated-type'], []);
  assert.deepEqual(s.perCode['deprecated-parser'], []);
  assert.equal(s.perCode['undeclared-read'].length, 2, 'untouched checks keep both fixes');

  // The echo half: hand the server back exactly what it used to publish.
  const client = new LspClient();
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: { diagnostics: { checkDeprecatedTypes: false } },
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri: CA_URI, languageId: 'esql', version: 1, text: CA_SRC },
    });
    const echo = {
      range: { start: { line: 2, character: 13 }, end: { line: 2, character: 20 } },
      message: "Data type 'LOGICAL' is legacy ESQL and deprecated. Use 'BOOLEAN' in ACE 12.",
      severity: 2,
      code: 'deprecated-type',
      source: 'esql',
    };
    const r = await client.request('textDocument/codeAction', {
      textDocument: { uri: CA_URI },
      range: echo.range,
      context: { diagnostics: [echo] },
    });
    assert.deepEqual(caShape(r), [], 'the check is off, so its fix is off too — echo or not');
  } finally {
    await client.close();
  }
});

/**
 * CODE_REVIEW.md C-6 (PLAN task 19) over a real stdio session: a clause
 * wrapped across two lines narrows on the CONTINUATION LINE — the line
 * prefix alone cannot know `SET` is above, so heuristic mode hands the
 * general list here (asserted by every non-gated run above) and only the
 * tree-backed path narrows. The `%%%` line is the grammar-ready gate:
 * `syntax-error` only ever comes off the tree, so waiting for it also
 * proves the grammar took over this document before the completion is
 * asked; its damage sits in another statement, which the clause reading
 * ignores (damage policy: only what precedes the cursor disqualifies).
 */
test('grammar mode completes a wrapped clause on the continuation line (C-6)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
    'CREATE COMPUTE MODULE T19E2E',
    '  CREATE FUNCTION Main() RETURNS BOOLEAN',
    '  BEGIN',
    '    DECLARE x INTEGER;',
    '    %%% junk;',
    '    SET',
    '      x ',
    '    ;',
    '  END;',
    'END MODULE',
    '',
  ].join('\n');
  const client = new LspClient();
  const uri = 'file:///tmp/esql-e2e/WrappedClauseC6.esql';
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: { textDocument: { publishDiagnostics: {} } },
      initializationOptions: {},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'esql', version: 1, text: src },
    });
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) => p.uri === uri && p.diagnostics.some((d: any) => d.code === 'syntax-error')
    );

    // line 6 (`      x `), cursor after the trailing space: flat analysis
    // sees only whitespace-plus-`x` and offers the general list.
    const comp = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 6, character: 8 },
    });
    const labels: string[] = (comp.result ?? comp).map((i: any) => i.label);
    assert.deepEqual(
      labels,
      ['=', 'TYPE', 'NAMESPACE', 'NAME', 'VALUE'],
      'the closed set-clauses list — the tree read `SET` from the line above'
    );
  } finally {
    await client.close();
  }
});
