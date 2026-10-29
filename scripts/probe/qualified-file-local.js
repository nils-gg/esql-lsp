// Measure file-local qualified answers for the module-qualification unit tests.
const d = require('../../dist/src/definitions');
const parser = require('../../dist/src/parser');

const SRC = [
  'CREATE COMPUTE MODULE Alpha', //                    0
  '',
  '    CREATE PROCEDURE Helper(IN name CHARACTER)', // 2  Helper 21-27
  '    BEGIN',
  "        SET name = 'a';",
  '    END;',
  '',
  '    CREATE PROCEDURE Worker()',
  '    BEGIN',
  '        CALL Helper(name);', //                     9  Helper 13-19
  '    END;',
  '',
  'END MODULE;',
  '',
  'CREATE COMPUTE MODULE Beta', //                     14
  '',
  '    CREATE PROCEDURE Helper(IN name CHARACTER)', // 16 Helper 21-27
  '    BEGIN',
  "        SET name = 'b';",
  '    END;',
  '',
  'END MODULE;',
  '',
  'CREATE COMPUTE MODULE Caller', //                   23
  '',
  '    CREATE FUNCTION Main() RETURNS BOOLEAN',
  '    BEGIN',
  "        CALL Alpha.Helper('one');", //              27 Helper 19-25
  "        CALL Beta.Helper('two');", //               28 Helper 18-24
  "        CALL Helper('three');", //                  29 Helper 13-19
  '        RETURN TRUE;',
  '    END;',
  '',
  'END MODULE;', //                                    33
].join('\n');

const f = (rs) => rs.map((r) => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`);

(async () => {
  await parser.initGrammar();
  const tree = parser.grammarReady() ? parser.analyzeDocument(parser.parse(SRC)) : null;
  const run = (label, fn) => {
    const heur = f(fn(undefined));
    console.log(label + '  heuristic ' + JSON.stringify(heur));
    if (tree) console.log(label + '  grammar   ' + JSON.stringify(f(fn(tree))) + (JSON.stringify(f(fn(tree))) === heur ? '  [same]' : '  [DIFFERENT]'));
  };
  run('def Alpha.Helper  ', (doc) => d.definitionAt(SRC, 27, 20, doc));
  run('def Beta.Helper   ', (doc) => d.definitionAt(SRC, 28, 20, doc));
  run('def bare in Caller', (doc) => d.definitionAt(SRC, 29, 14, doc));
  run('def bare in Worker', (doc) => d.definitionAt(SRC, 9, 14, doc));
  run('refs from Alpha   ', (doc) => d.referencesAt(SRC, 2, 24, true, doc));
  run('refs from Beta    ', (doc) => d.referencesAt(SRC, 16, 24, true, doc));
  run('refs from Alpha only', (doc) => d.referencesAt(SRC, 2, 24, false, doc));
  run('def on qualifier  ', (doc) => d.definitionAt(SRC, 27, 15, doc));
  const t = require('../../dist/src/definitions');
  console.log('target(27,20)', JSON.stringify(t.callTargetAt(SRC, 27, 20)));
  console.log('target(27,15)', JSON.stringify(t.callTargetAt(SRC, 27, 15)));
  console.log('target(29,14)', JSON.stringify(t.callTargetAt(SRC, 29, 14)));
  const dotted = "        SET OutputRoot.JSON.Data = 1;";
  console.log('target on tree path', JSON.stringify(t.callTargetAt(dotted, 0, 20)));
  const quoted = '    CALL "Weird Name"(x);';
  console.log('target quoted', JSON.stringify(t.callTargetAt(quoted, 0, 10)));
  console.log('callSites', JSON.stringify(t.callSitesForName(SRC, 'Helper')));
})();
