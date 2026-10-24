/**
 * End-to-end test: spawns the compiled server as a child process and speaks
 * LSP over stdio (Content-Length framed JSON-RPC) — the same protocol
 * Neovim and OpenCode use against it.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
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
    await client.waitFor(
      'textDocument/publishDiagnostics',
      (p) =>
        p.uri === uri &&
        p.diagnostics.some(
          (d: any) => d.severity === 1 && /Syntax error|Missing syntax/.test(d.message)
        )
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
      capabilities: {},
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
    'no-propagation',
    'unclosed-main',
    'deprecated-parser',
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
 * ISSUES.md I-6 over a real stdio session: a file whose module is unclosed —
 * the state of every buffer being typed. `syntax-error` only ever comes from
 * the tree path, so waiting for it also proves the grammar took over this
 * document; the publish that carries it must NOT have lost the semantic
 * checks the heuristic pass had already reported.
 */
test('grammar mode keeps semantic checks inside a damaged file (I-6)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
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
      `undeclared name still reported inside the damaged region: ${JSON.stringify(diags.diagnostics.map((d: any) => [d.code, d.message]))}`
    );
    assert.ok(codes.includes('missing-end-module'), 'module structure check still fires too');
    const und = diags.diagnostics.find((d: any) => d.code === 'undeclared-variable');
    assert.equal(und.range.start.line, 5, 'exact line of the SET inside the ERROR region');
    assert.equal(
      und.codeDescription?.href,
      'https://github.com/nils-gg/esql-lsp#diagnostics',
      'codeDescription survives the real protocol (optional, but sent)'
    );
  } finally {
    await client.close();
  }
});
