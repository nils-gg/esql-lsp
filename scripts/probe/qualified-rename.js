// Probe: module-routine rename — ambiguous refusal and clean module-qualified
// sweep. Prints literal answers for the e2e pins (Enh 17/33).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALPHA = [
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
].join('\n');

const BETA = [
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
].join('\n');

// With the bare call: the name is ambiguous → the rename must refuse.
const CALLER_AMBIG = [
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
].join('\n');

// Every use spells its module: the rename has a provable target.
const CALLER_CLEAN = [
  'CREATE COMPUTE MODULE Caller',
  '',
  '    CREATE FUNCTION Main() RETURNS BOOLEAN',
  '    BEGIN',
  "        CALL Alpha.Helper('one');",
  "        CALL Beta.Helper('two');",
  '        RETURN TRUE;',
  '    END;',
  '',
  'END MODULE;',
].join('\n');

async function session(caller) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esql-qren-'));
  const files = { 'alpha.esql': ALPHA, 'beta.esql': BETA, 'caller.esql': caller };
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'esql-lsp.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const notes = [];
  server.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const len = +/Content-Length: (\d+)/.exec(buf.slice(0, sep).toString())[1];
      if (buf.length < sep + 4 + len) return;
      const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
      buf = buf.slice(sep + 4 + len);
      if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
      else if (msg.method === 'window/showMessage' || msg.method === 'window/showMessageRequest')
        notes.push(msg.params.message);
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
  await send('initialize', { rootUri: `file://${dir}`, capabilities: {}, initializationOptions: {} });
  notify('initialized', {});
  for (const [n, t] of Object.entries(files)) {
    notify('textDocument/didOpen', { textDocument: { uri: uri(n), languageId: 'esql', version: 1, text: t } });
  }
  await new Promise((r) => setTimeout(r, 600));
  return {
    dir,
    server,
    notes,
    prepare: async (file, line, ch) => {
      const m = await send('textDocument/prepareRename', { textDocument: { uri: uri(file) }, position: { line, character: ch } });
      return m.error ? { error: m.error.message } : m.result;
    },
    ren: async (file, line, ch, newName) => {
      const m = await send('textDocument/rename', {
        textDocument: { uri: uri(file) },
        position: { line, character: ch },
        newName,
      });
      if (m.error) return { error: m.error.message };
      const res = m.result;
      if (!res) return null;
      const shape = (map) =>
        Object.entries(map).flatMap(([u, edits]) =>
          edits.map((e) => `${path.basename(u)} ${e.range.start.line}:${e.range.start.character}->${JSON.stringify(e.newText)}`)
        );
      return res.changes ? shape(res.changes) : { docChanges: res.documentChanges };
    },
    close: async () => {
      await send('shutdown', null);
      notify('exit', null);
      server.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

(async () => {
  console.log('mode: ' + (process.env.ESQL_LSP_NO_GRAMMAR ? 'heuristic' : 'grammar'));
  const amb = await session(CALLER_AMBIG);
  console.log('prepare (ambiguous) => ' + JSON.stringify(await amb.prepare('alpha.esql', 3, 24)));
  console.log('rename  (ambiguous) => ' + JSON.stringify(await amb.ren('alpha.esql', 3, 24, 'Assist')));
  console.log('prepare from the bare call => ' + JSON.stringify(await amb.prepare('caller.esql', 6, 14)));
  console.log('rename  from the bare call => ' + JSON.stringify(await amb.ren('caller.esql', 6, 14, 'Assist')));
  await amb.close();

  const clean = await session(CALLER_CLEAN);
  console.log('prepare (clean)     => ' + JSON.stringify(await clean.prepare('alpha.esql', 3, 24)));
  console.log('rename  (clean)     => ' + JSON.stringify(await clean.ren('alpha.esql', 3, 24, 'Assist')));
  console.log('notes               => ' + JSON.stringify(clean.notes));
  await clean.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
