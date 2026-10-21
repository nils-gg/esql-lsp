/**
 * ESQL code snippets, ported from joaquinvulcano/esql-vscode
 * (snippets/esql.code-snippets, MIT) — see ATTRIBUTION.md.
 *
 * VS Code snippet placeholder syntax (`${1:placeholder}`, `${1|a,b|}`, `$0`)
 * is identical to LSP SnippetString syntax, so bodies port over verbatim.
 * Titles and placeholder text translated to English.
 */

export interface EsqlSnippet {
  /** What the user types (also the completion label). */
  label: string;
  description: string;
  /** LSP snippet string. */
  insertText: string;
}

export const ESQL_SNIPPETS: EsqlSnippet[] = [
  {
    label: 'module-compute',
    description: 'Compute Module skeleton',
    insertText:
      "BROKER SCHEMA ${1:com.example.integrations}\n" +
      '\n' +
      'CREATE COMPUTE MODULE ${2:FlowName}_${3:Compute}\n' +
      '\tCREATE FUNCTION Main() RETURNS BOOLEAN\n' +
      '\tBEGIN\n' +
      '\t\t-- Copy headers\n' +
      "\t\tSET OutputRoot.Properties = InputRoot.Properties;\n" +
      '\t\t\n' +
      '\t\t$0\n' +
      '\t\t\n' +
      '\t\tRETURN TRUE;\n' +
      '\tEND;\n' +
      'END MODULE;',
  },
  {
    label: 'module-filter',
    description: 'Filter Module skeleton',
    insertText:
      "BROKER SCHEMA ${1:com.example.integrations}\n" +
      '\n' +
      'CREATE FILTER MODULE ${2:FlowName}_${3:Filter}\n' +
      '\tCREATE FUNCTION Main() RETURNS BOOLEAN\n' +
      '\tBEGIN\n' +
      '\t\t$0\n' +
      '\t\tRETURN TRUE;\n' +
      '\tEND;\n' +
      'END MODULE;',
  },
  {
    label: 'module-database',
    description: 'Database Module skeleton',
    insertText:
      "BROKER SCHEMA ${1:com.example.integrations}\n" +
      '\n' +
      'CREATE DATABASE MODULE ${2:FlowName}_${3:Database}\n' +
      '\tCREATE FUNCTION Main() RETURNS BOOLEAN\n' +
      '\tBEGIN\n' +
      '\t\t$0\n' +
      '\t\tRETURN TRUE;\n' +
      '\tEND;\n' +
      'END MODULE;',
  },
  {
    label: 'procedure',
    description: 'PROCEDURE declaration',
    insertText:
      'CREATE PROCEDURE ${1:procedureName}(${2:IN param1 CHARACTER})\n' +
      'BEGIN\n' +
      '\t$0\n' +
      'END;',
  },
  {
    label: 'function',
    description: 'FUNCTION declaration with return value',
    insertText:
      'CREATE FUNCTION ${1:functionName}(${2:IN param1 CHARACTER}) RETURNS ${3:CHARACTER}\n' +
      'BEGIN\n' +
      '\t$0\n' +
      '\tRETURN ${4:result};\n' +
      'END;',
  },
  {
    label: 'declare',
    description: 'DECLARE variable',
    insertText:
      "DECLARE ${1:varName} ${2|CHARACTER,INTEGER,FLOAT,DECIMAL,BOOLEAN,BLOB,DATE,TIMESTAMP,REFERENCE,ROW|}${3: DEFAULT ${4:''}};\n" +
      '$0',
  },
  {
    label: 'declare-const',
    description: 'DECLARE constant',
    insertText:
      "DECLARE ${1:CONSTANT_NAME} CONSTANT CHARACTER '${2:value}';\n" +
      '$0',
  },
  {
    label: 'declare-ref',
    description: 'DECLARE REFERENCE',
    insertText:
      'DECLARE ${1:ref} REFERENCE TO ${2:InputRoot.JSON.Data};\n' +
      '$0',
  },
  {
    label: 'if',
    description: 'IF / ELSEIF / ELSE block',
    insertText:
      'IF ${1:condition} THEN\n' +
      '\t$0\n' +
      'ELSEIF ${2:otherCondition} THEN\n' +
      '\t\n' +
      'ELSE\n' +
      '\t\n' +
      'END IF;',
  },
  {
    label: 'ifs',
    description: 'Simple IF block',
    insertText:
      'IF ${1:condition} THEN\n' +
      '\t$0\n' +
      'END IF;',
  },
  {
    label: 'while',
    description: 'WHILE loop',
    insertText:
      'WHILE ${1:condition} DO\n' +
      '\t$0\n' +
      'END WHILE;',
  },
  {
    label: 'for',
    description: 'FOR loop over message tree nodes',
    insertText:
      'FOR ${1:item} AS ${2:InputRoot.XMLNSC.${3:Root}.${4:Items}.${5:Item}}[]\n' +
      'DO\n' +
      '\t$0\n' +
      'END FOR;',
  },
  {
    label: 'case',
    description: 'CASE block',
    insertText:
      'CASE ${1:variable}\n' +
      "\tWHEN ${2:'value1'} THEN\n" +
      '\t\t$0\n' +
      "\tWHEN ${3:'value2'} THEN\n" +
      '\t\t\n' +
      '\tELSE\n' +
      '\t\t\n' +
      'END CASE;',
  },
  {
    label: 'set-json',
    description: 'Set JSON field in output',
    insertText: 'SET OutputRoot.JSON.Data.${1:field} = ${2:InputRoot.JSON.Data.field};',
  },
  {
    label: 'set-xml',
    description: 'Set XML field in output',
    insertText:
      'SET OutputRoot.XMLNSC.${1:Root}.${2:field} = ${3:InputRoot.XMLNSC.Root.field};',
  },
  {
    label: 'copy-input',
    description: 'Copy entire InputRoot to OutputRoot',
    insertText: 'SET OutputRoot = InputRoot;',
  },
  {
    label: 'copy-headers',
    description: 'Copy MQ headers + Properties',
    insertText:
      'SET OutputRoot.Properties = InputRoot.Properties;\n' +
      'SET OutputRoot.MQMD = InputRoot.MQMD;',
  },
  {
    label: 'copy-json',
    description: 'Copy headers + JSON Data',
    insertText:
      'SET OutputRoot.Properties = InputRoot.Properties;\n' +
      'SET OutputRoot.JSON.Data = InputRoot.JSON.Data;',
  },
  {
    label: 'copy-xml',
    description: 'Copy headers + XMLNSC',
    insertText:
      'SET OutputRoot.Properties = InputRoot.Properties;\n' +
      'SET OutputRoot.XMLNSC = InputRoot.XMLNSC;',
  },
  {
    label: 'delete-field',
    description: 'DELETE a field from the tree',
    insertText: 'DELETE FIELD ${1:OutputRoot.JSON.Data.field};',
  },
  {
    label: 'delete-children',
    description: 'DELETE all children of a node',
    insertText: 'DELETE FIELD ${1:OutputRoot}.*[<];',
  },
  {
    label: 'propagate',
    description: 'PROPAGATE TO TERMINAL',
    insertText: "PROPAGATE TO TERMINAL '${1|out,alternate,failure|}';\n$0",
  },
  {
    label: 'propagate-env',
    description: 'PROPAGATE copying LocalEnvironment',
    insertText:
      'SET OutputLocalEnvironment = InputLocalEnvironment;\n' +
      "PROPAGATE TO TERMINAL '${1|out,alternate|}';\n" +
      '$0',
  },
  {
    label: 'throw',
    description: 'THROW USER EXCEPTION',
    insertText:
      'THROW USER EXCEPTION\n' +
      '\tMESSAGE 2951\n' +
      '\tSEVERITY 3\n' +
      "\tCATALOG 'BIPmsgs'\n" +
      "\tVALUES('${1:error message}', '${2:ERROR_CODE}');",
  },
  {
    label: 'trycatch',
    description: 'BEGIN block with SQLSTATE HANDLER',
    insertText:
      'BEGIN\n' +
      "\tDECLARE CONTINUE HANDLER FOR SQLSTATE LIKE '%'\n" +
      '\tBEGIN\n' +
      '\t\t-- Handle SQL error\n' +
      "\t\tDECLARE errMsg CHARACTER FIELDVALUE(InputExceptionList.*[1].*[1].Text);\n" +
      '\t\t$1\n' +
      '\tEND;\n' +
      '\t\n' +
      '\t$0\n' +
      'END;',
  },
  {
    label: 'passthru',
    description: 'PASSTHRU database query',
    insertText:
      'DECLARE ${1:result} ${2:CHARACTER};\n' +
      "PASSTHRU('SELECT ${3:column} FROM ${4:table} WHERE ${5:id} = ?',\n" +
      '\t${6:InputRoot.JSON.Data.id})\n' +
      '\tTO Database.${7:DS_YOUR_DATASOURCE};\n' +
      '$0',
  },
  {
    label: 'select-into',
    description: 'SELECT INTO variable',
    insertText:
      'SELECT ITEM T.${1:column} INTO ${2:myVar}\n' +
      'FROM Database.${3:DS_YOUR_DATASOURCE}.${4:TABLE} AS T\n' +
      'WHERE T.${5:ID} = ${6:InputRoot.JSON.Data.id};\n' +
      '$0',
  },
  {
    label: 'cast',
    description: 'CAST to a type',
    insertText: 'CAST(${1:value} AS ${2|CHARACTER,INTEGER,FLOAT,DECIMAL,BOOLEAN,DATE,TIMESTAMP|})',
  },
  {
    label: 'cast-date',
    description: 'CAST string to DATE',
    insertText: "CAST(${1:InputRoot.JSON.Data.date} AS DATE FORMAT '${2:yyyy-MM-dd}')",
  },
  {
    label: 'cast-ts',
    description: 'CAST string to TIMESTAMP',
    insertText: "CAST(${1:InputRoot.JSON.Data.timestamp} AS TIMESTAMP FORMAT '${2:yyyy-MM-dd HH:mm:ss}')",
  },
  {
    label: 'format-ts',
    description: 'Format timestamp as string',
    insertText: "CAST(${1:CURRENT_TIMESTAMP} AS CHARACTER FORMAT '${2:yyyy-MM-dd HH:mm:ss}')",
  },
  {
    label: 'coalesce',
    description: 'COALESCE with default',
    insertText: "COALESCE(${1:field}, ${2:'default value'})",
  },
  {
    label: 'cardinality',
    description: 'Count array nodes',
    insertText: 'CARDINALITY(${1:InputRoot.XMLNSC.Root.Items.Item}[])',
  },
  {
    label: 'exists',
    description: 'Check node existence',
    insertText: 'EXISTS(${1:InputRoot.JSON.Data.field}[])',
  },
  {
    label: 'substring',
    description: 'Extract substring',
    insertText: 'SUBSTRING(${1:string} FROM ${2:1} FOR ${3:10})',
  },
  {
    label: 'exception-msg',
    description: 'Read ExceptionList message + number',
    insertText:
      'DECLARE ${1:errText} CHARACTER FIELDVALUE(InputExceptionList.*[1].*[1].Text);\n' +
      'DECLARE ${2:errNumber} INTEGER FIELDVALUE(InputExceptionList.*[1].*[1].Number);\n' +
      '$0',
  },
  {
    label: 'set-env',
    description: 'Set Environment variable',
    insertText: "SET Environment.Variables.${1:VarName} = ${2:'value'};",
  },
  {
    label: 'get-env',
    description: 'Read Environment variable',
    insertText: 'DECLARE ${1:myVar} CHARACTER FIELDVALUE(Environment.Variables.${2:VarName});',
  },
  {
    label: 'json-error-response',
    description: 'JSON error response',
    insertText:
      'SET OutputRoot.Properties = InputRoot.Properties;\n' +
      "SET OutputRoot.JSON.Data.code = '${1:ERROR}';\n" +
      "SET OutputRoot.JSON.Data.message = '${2:An unexpected error occurred}';\n" +
      "SET OutputRoot.JSON.Data.timestamp = CAST(CURRENT_TIMESTAMP AS CHARACTER FORMAT 'yyyy-MM-dd HH:mm:ss');\n" +
      '$0',
  },
  {
    label: 'json-ok-response',
    description: 'JSON success response',
    insertText:
      'SET OutputRoot.Properties = InputRoot.Properties;\n' +
      "SET OutputRoot.JSON.Data.code = 'OK';\n" +
      "SET OutputRoot.JSON.Data.message = '${1:Operation completed successfully}';\n" +
      "SET OutputRoot.JSON.Data.timestamp = CAST(CURRENT_TIMESTAMP AS CHARACTER FORMAT 'yyyy-MM-dd HH:mm:ss');\n" +
      '$0',
  },
  {
    label: 'log',
    description: 'Log step to Environment',
    insertText:
      "SET Environment.Log.${1:step} = '${2:description}';\n" +
      "SET Environment.Log.${1:step}Timestamp = CAST(CURRENT_TIMESTAMP AS CHARACTER FORMAT 'yyyy-MM-dd HH:mm:ss');\n" +
      '$0',
  },
  {
    label: 'http-header',
    description: 'Set HTTP request headers',
    insertText:
      'SET OutputRoot.HTTPRequestHeader."${1:Content-Type}" = \'${2:application/json}\';\n' +
      'SET OutputRoot.HTTPRequestHeader."${3:Authorization}" = \'${4:Bearer }\' || ${5:Environment.Variables.Token};\n' +
      '$0',
  },
  {
    label: 'http-status',
    description: 'Read HTTP response status',
    insertText:
      'DECLARE ${1:httpStatus} INTEGER FIELDVALUE(InputRoot.HTTPResponseHeader."X-Original-HTTP-Status-Code");\n' +
      'IF ${1:httpStatus} <> 200 THEN\n' +
      '\t$0\n' +
      'END IF;',
  },
];
