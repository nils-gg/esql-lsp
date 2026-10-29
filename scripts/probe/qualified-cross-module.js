// Probe: qualified cross-module resolution over a real stdio session.
// Prints the raw answers so e2e literals can be pinned from measurement.
const { spawn } = require('child_process');

const WS = {
  'alpha.esql': [
    '-- Module Alpha',
    'CREATE COMPUTE MODULE Alpha',
    '',
    '    CREATE PROCEDURE Helper(IN name CHARACTER)',
    '    BEGIN',
    '        DECLARE x CHARACTER(64);',
    '        SET x = name;',
    '    END;',
    '',
    '    CREATE PROCEDURE Worker()',
    '    BEGIN',
    '        DECLARE v CHARACTER(32);',
    "        SET v = 'a';",
    '        CALL Helper(v);',
    '    END;',
    '',
    'END MODULE;',
  ].join('\n'),
  'beta.esql': [
    '-- Module Beta: same routine name as Alpha',
    'CREATE COMPUTE MODULE Beta',
    '',
    '    CREATE PROCEDURE Helper(IN name CHARACTER)',
    '    BEGIN',
    '        DECLARE z CHARACTER(64);',
    '        SET z = name;',
    '    END;',
    '',
    'END MODULE;',
  ].join('\n'),
  'caller.esql': [
    '-- Module caller: uses both Helpers',
    'CREATE COMPUTE MODULE Caller',
    '',
    '    CREATE FUNCTION Main() RETURNS BOOLEAN',
    '    BEGIN',
    "        CALL Alpha.Helper('one');",
    "        CALL Beta.Helper('two');",
    "        CALL Helper('three');",
    '        RETURN TRUE;',
    '    END;',
    '',
    'END MODULE;',
  ].join('\n'),
};

const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-qualify-probe-'));
  for (const [name, text] of Object.entries(WS)) fs.writeFileSync(path.join(dir, name), text);
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'esql-lsp.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const notifs = [];
  server.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = buf.slice(0, sep).toString();
      const len = +/Content-Length: (\d+)/.exec(header)[1];
      if (buf.length < sep + 4 + len) return;
      const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
      buf = buf.slice(sep + 4 + len);
      if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
      else notifs.push(msg);
    }
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((res) => {
      const my = ++id;
      pending.set(my, res);
      const body = JSON.stringify({ jsonrpc: '2.0', id: my, method, params });
      server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  const notify = (method, params) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const uri = (n) => `file://${path.join(dir, n)}`;
  const waitDiags = (u) =>
    new Promise((res) => {
      const t0 = Date.now();
      const tick = () => {
        if (notifs.some((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === u)) return res();
        if (Date.now() - t0 > 8000) return res();
        setTimeout(tick, 50);
      };
      tick();
    });

  await send('initialize', {
    rootUri: `file://${dir}`,
    capabilities: {},
    initializationOptions: { routineDuplicates: false, unreferenced: false },
  });
  notify('initialized', {});
  for (const [name, text] of Object.entries(WS)) {
    notify('textDocument/didOpen', {
      textDocument: { uri: uri(name), languageId: 'esql', version: 1, text },
    });
  }
  for (const n of Object.keys(WS)) await waitDiags(uri(n));
  const diagLines = notifs
    .filter((m) => m.method === 'textDocument/publishDiagnostics')
    .map((m) => path.basename(m.params.uri) + ': ' + m.params.diagnostics.length + ' diags');
  console.log('open: ' + JSON.stringify(diagLines));

  const pos = (file, line, character) => ({ textDocument: { uri: uri(file) }, position: { line, character } });
  const short = (r) =>
    Array.isArray(r)
      ? r.map((l) => `${path.basename(l.uri)} ${l.range.start.line}:${l.range.start.character}-${l.range.end.line}:${l.range.end.character}`)
      : r;
  const reqs = [
    ['def alpha target', await send('textDocument/definition', pos('caller.esql', 5, 20))],
    ['def beta target', await send('textDocument/definition', pos('caller.esql', 6, 20))],
    ['def ambiguous', await send('textDocument/definition', pos('caller.esql', 7, 14))],
    ['hover alpha target', await send('textDocument/hover', pos('caller.esql', 5, 20))],
    ['hover ambiguous', await send('textDocument/hover', pos('caller.esql', 7, 14))],
    [
      'refs alpha Helper',
      await send('textDocument/references', {
        ...pos('alpha.esql', 3, 24),
        context: { includeDeclaration: true },
      }),
    ],
    [
      'refs beta Helper',
      await send('textDocument/references', {
        ...pos('beta.esql', 3, 24),
        context: { includeDeclaration: true },
      }),
    ],
  ];
  console.log(JSON.stringify(process.env.ESQL_LSP_NO_GRAMMAR ? 'heuristic' : 'grammar'));
  for (const [name, msg] of reqs) {
    if (msg.error) {
      console.log(name + ' ERROR ' + JSON.stringify(msg.error));
      continue;
    }
    const r = msg.result;
    if (name.startsWith('hover')) {
      console.log(name + ' => ' + JSON.stringify(r ? r.contents.value : null));
    } else {
      console.log(name + ' => ' + JSON.stringify(short(r ?? null)));
    }
  }
  await send('shutdown', null);
  notify('exit', null);
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
