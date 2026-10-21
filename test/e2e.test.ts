/**
 * End-to-end test: spawns the compiled server as a child process and speaks
 * LSP over stdio (Content-Length framed JSON-RPC) — the same protocol
 * Neovim and OpenCode use against it.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

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
  private waiters: Array<{
    method: string;
    predicate: (params: any) => boolean;
    resolve: (params: any) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor() {
    this.child = spawn(process.execPath, [SERVER], { stdio: 'pipe' });
    this.child.stdout.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr.on('data', () => {
      /* server logs to stderr are expected; ignore */
    });
  }

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
      capabilities: {},
      initializationOptions: { diagnostics: { checkMissingSemicolon: false } },
    });
    const caps = init.result.capabilities;
    assert.ok(caps.completionProvider, 'completion capability');
    assert.ok(caps.hoverProvider, 'hover capability');
    assert.ok(caps.documentSymbolProvider, 'document symbol capability');
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

    const comp2 = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 12, character: 0 }, // empty last line -> general, no prefix filter
    });
    const labels2: string[] = (comp2.result ?? comp2).map((i: any) => i.label);
    assert.ok(labels2.includes('CAST'), 'offers built-in functions');
    assert.ok(labels2.includes('PROPAGATE'), 'offers keywords');
    assert.ok(labels2.includes('module-compute'), 'offers snippets');
    assert.ok(labels2.includes('myVar'), 'offers declared variables');

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

test('grammar-backed session: syntax errors and semantic tokens', async () => {
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
