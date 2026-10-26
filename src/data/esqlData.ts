/**
 * ESQL language data: keywords, data types, message tree variables, parser
 * domains and built-in function documentation.
 *
 * Ported from joaquinvulcano/esql-vscode (MIT) — see ATTRIBUTION.md.
 * Function list extended beyond the original 26 entries; documentation
 * translated to English.
 */

// ─── Keywords ────────────────────────────────────────────────────────────────

export const ESQL_KEYWORDS: string[] = [
  // Module / declaration
  'BROKER', 'SCHEMA', 'CREATE', 'COMPUTE', 'FILTER', 'DATABASE', 'MODULE',
  'FUNCTION', 'PROCEDURE', 'EXTERNAL', 'RETURNS', 'RETURN',
  'DECLARE', 'CONSTANT', 'PATH',
  // Message tree operations
  'SET', 'DELETE', 'FIELD', 'MOVE', 'DETACH', 'ATTACH', 'COPY', 'TO', 'OF',
  // Control flow
  'BEGIN', 'END', 'IF', 'THEN', 'ELSEIF', 'ELSE', 'WHILE', 'DO',
  'REPEAT', 'UNTIL', 'FOR', 'LEAVE', 'ITERATE', 'CASE', 'WHEN', 'LOOP',
  // Propagation / exceptions
  'PROPAGATE', 'TERMINAL', 'LABEL', 'ENVIRONMENT', 'EXCEPTION', 'THROW',
  'USER', 'RESIGNAL', 'HANDLER', 'CONTINUE', 'EXIT', 'UNDO', 'ATOMIC',
  'MESSAGE', 'SEVERITY', 'CATALOG', 'VALUES', 'NUMBER', 'TEXT',
  // Procedures / database
  'CALL', 'IN', 'OUT', 'INOUT', 'PASSTHRU', 'EVAL', 'DATASOURCE',
  // SELECT (over message tree sets)
  'SELECT', 'FROM', 'WHERE', 'AS', 'INTO', 'ITEM', 'THE', 'SINGULAR',
  'FIRST', 'LAST', 'NEXT', 'PRIOR', 'DISTINCT',
  'GROUP BY', 'HAVING', 'ORDER BY', 'ASC', 'DESC',
  // Expressions
  'AND', 'OR', 'NOT', 'LIKE', 'BETWEEN', 'EXISTS', 'IS NULL', 'IS NOT NULL',
  'TRUE', 'FALSE', 'NULL', 'UNKNOWN',
  // Data types (also offered as type completions)
  'CHARACTER', 'INTEGER', 'FLOAT', 'DECIMAL', 'BOOLEAN', 'BLOB', 'BIT',
  'DATE', 'TIME', 'TIMESTAMP', 'INTERVAL', 'ROW', 'REFERENCE', 'NAMESPACE',
  // Message tree node properties
  'FIRSTCHILD', 'LASTCHILD', 'NEXTSIBLING', 'PREVIOUSSIBLING', 'PARENT',
  'NAME', 'VALUE', 'TYPE',
  // SQL diagnostic fields
  'SQLSTATE', 'SQLCODE', 'SQLERRORTEXT', 'SQLNATIVEERROR',
  // Backfill from the two official keyword pages (app-connect/12.0.x
  // "ESQL reserved keywords" + "ESQL non-reserved keywords", both fetched
  // verbatim 2026-10-26). The curated list above missed real keywords the
  // flat diagnostics scans run into (`INSERT INTO`, `IS [NOT] INF`,
  // `BETWEEN SYMMETRIC`, `PROPAGATE … FINALIZE NONE`, `LIKE … ESCAPE`),
  // and every miss became a false `unknown-routine`/`undeclared-read`.
  // Words the pages list that ESQL_FUNCTIONS already documents (CHAR,
  // COUNT, CURRENT_*, LOG, MAX, MIN, SUM, UUIDAS*) are deliberately not
  // duplicated here — the check allow lists union both arrays.
  // Reserved (all 12):
  'ALL', 'ASYMMETRIC', 'BOTH', 'LEADING', 'SYMMETRIC', 'TRAILING',
  // Non-reserved, the rest of the page:
  'ANY', 'BY', 'CCSID', 'CONDITION', 'COORDINATED', 'DATA', 'DAY',
  'DAYOFWEEK', 'DAYOFYEAR', 'DAYS', 'DEFAULT', 'DOMAIN', 'DYNAMIC',
  'ENCODING', 'ESCAPE', 'ESQL', 'EVENT', 'FINALIZE', 'FORMAT', 'FOUND',
  'FULL', 'GMTTIME', 'GMTTIMESTAMP', 'GROUP', 'HOUR', 'IDENTITY', 'INF',
  'INFINITY', 'INSERT', 'INT', 'IS', 'ISLEAPYEAR', 'JAVA', 'LANGUAGE',
  'LIST', 'LOCALTIMEZONE', 'MODIFIES', 'MONTH', 'MONTHS', 'NAN', 'NONE',
  'NUM', 'OPTIONS', 'ORDER', 'PARSE', 'PLACING', 'QUARTEROFYEAR',
  'QUARTERS', 'READS', 'RESULT', 'SAMEFIELD', 'SECOND', 'SETS', 'SHARED',
  'SHORT', 'SOME', 'SQL', 'SQLEXCEPTION', 'SQLWARNING', 'TRACE',
  'UNCOORDINATED', 'UPDATE', 'WEEKOFMONTH', 'WEEKOFYEAR', 'WEEKS', 'YEAR',
];

// ─── Data types ──────────────────────────────────────────────────────────────

export interface EsqlTypeDoc {
  name: string;
  description: string;
}

export const ESQL_TYPES: EsqlTypeDoc[] = [
  { name: 'CHARACTER', description: 'Text string (VARCHAR-equivalent).' },
  { name: 'INTEGER', description: 'Whole number.' },
  { name: 'FLOAT', description: 'Approximate real number.' },
  { name: 'DECIMAL', description: 'Exact real number.' },
  { name: 'BOOLEAN', description: 'TRUE or FALSE.' },
  {
    name: 'LOGICAL',
    description:
      'Legacy truth value (pre-ACE ESQL), still compiled by ACE 12 — **deprecated**: prefer `BOOLEAN`.',
  },
  { name: 'DATE', description: 'Date without time.' },
  { name: 'TIME', description: 'Time without date.' },
  { name: 'TIMESTAMP', description: 'Date and time combined.' },
  { name: 'BLOB', description: 'Binary data.' },
  { name: 'BIT', description: 'Single bit.' },
  { name: 'INTERVAL', description: 'Interval between dates/times.' },
  { name: 'ROW', description: 'Compound type (typed row).' },
  { name: 'REFERENCE', description: 'Reference to a node in the message tree.' },
  { name: 'NAMESPACE', description: 'XML namespace (prefix + URI).' },
];

// ─── Message tree variables ──────────────────────────────────────────────────

export interface EsqlTreeVarDoc {
  name: string;
  description: string;
}

export const ESQL_MESSAGE_TREE_VARS: EsqlTreeVarDoc[] = [
  {
    name: 'InputRoot',
    description:
      'Complete incoming message tree. Contains every domain: Properties, MQMD, JSON/XMLNSC/MRM payload, HTTP headers, etc.',
  },
  {
    name: 'OutputRoot',
    description:
      'Complete outgoing message tree. Must be built (or copied from InputRoot) before propagating.',
  },
  {
    name: 'InputLocalEnvironment',
    description:
      'LocalEnvironment of the incoming message: transport routing and metadata (ReplyToQueue, CorrelationId, ...).',
  },
  {
    name: 'OutputLocalEnvironment',
    description:
      'LocalEnvironment of the outgoing message. Use it to control MQ destination and other transport properties.',
  },
  {
    name: 'LocalEnvironment',
    description:
      'Alias for the current LocalEnvironment (input or output depending on context).',
  },
  {
    name: 'Environment',
    description:
      'User variables that persist across every node of the flow. Ideal for intermediate state shared between compute nodes.',
  },
  {
    name: 'InputExceptionList',
    description:
      'Exception list of the incoming message (available in failure/catch handlers).',
  },
  {
    name: 'OutputExceptionList',
    description: 'Exception list for the outgoing message.',
  },
  {
    name: 'DestinationList',
    description:
      'List of destinations for dynamic routing to multiple queues/endpoints.',
  },
];

// ─── Parsers / message domains ───────────────────────────────────────────────

export interface EsqlDomainDoc {
  name: string;
  detail: string;
  description: string;
}

export const ESQL_DOMAINS: EsqlDomainDoc[] = [
  { name: 'JSON', detail: 'JSON parser', description: 'Access to the JSON tree. Continue with .Data.<field>' },
  { name: 'XMLNSC', detail: 'XML parser (modern)', description: 'Recommended XML parser in ACE 12. Supports namespaces.' },
  { name: 'MRM', detail: 'Message Repository Manager', description: 'Flat files, binary and repository-defined messages.' },
  { name: 'BLOB', detail: 'Binary payload', description: 'Raw binary content of the message.' },
  { name: 'MIME', detail: 'MIME parser', description: 'Messages with MIME attachments.' },
  { name: 'Properties', detail: 'Message properties', description: 'Message properties (MessageDomain, MessageSet, ...).' },
  { name: 'MQMD', detail: 'MQ message descriptor', description: 'MQ message header (MsgId, CorrelId, ReplyToQ, ...).' },
  { name: 'MQRFH2', detail: 'MQ RFH2 header', description: 'RFH2 header for JMS and routing.' },
  { name: 'HTTPInputHeader', detail: 'HTTP input headers', description: 'HTTP request headers of the incoming request.' },
  { name: 'HTTPOutputHeader', detail: 'HTTP output headers', description: 'HTTP response headers of the outgoing response.' },
  { name: 'HTTPRequestHeader', detail: 'HTTP request headers (outbound)', description: 'HTTP headers to send with an outbound HTTP request.' },
  { name: 'HTTPResponseHeader', detail: 'HTTP response headers (inbound)', description: 'HTTP headers received from an outbound HTTP response.' },
];

/**
 * Common LocalEnvironment fields (the full set is deployment-specific;
 * Phase 3 will offer model-driven completion here).
 */
export const ESQL_LOCAL_ENVIRONMENT_FIELDS: EsqlDomainDoc[] = [
  { name: 'ReplyToQueue', detail: 'MQ reply-to queue', description: 'Queue name for asynchronous replies.' },
  { name: 'ReplyToQueueManager', detail: 'MQ reply-to queue manager', description: 'Queue manager for asynchronous replies.' },
  { name: 'CorrelationId', detail: 'MQ correlation id', description: 'Correlation id for request/reply pairing.' },
  { name: 'MsgId', detail: 'MQ message id', description: 'Message id assigned by the message producer.' },
  { name: 'Destination', detail: 'Routing destination', description: 'Destination used for routing the message.' },
  { name: 'MQMD', detail: 'MQ message descriptor', description: 'Full MQMD header accessible from LocalEnvironment.' },
];

// ─── Built-in functions ──────────────────────────────────────────────────────

export interface EsqlFunctionDoc {
  name: string;
  signature: string;
  description: string;
  example?: string;
  returnType?: string;
}

export const ESQL_FUNCTIONS: EsqlFunctionDoc[] = [
  // String
  {
    name: 'CHAR',
    signature: 'CHAR(code INTEGER)',
    description: 'Returns the character for the given code point.',
    returnType: 'CHARACTER',
  },
  {
    name: 'CONTAINS',
    signature: 'CONTAINS(string, search)',
    description: 'Returns TRUE if `search` occurs anywhere in `string`.',
    returnType: 'BOOLEAN',
  },
  {
    name: 'ENDSWITH',
    signature: 'ENDSWITH(string, suffix)',
    description: 'Returns TRUE if `string` ends with `suffix`.',
    returnType: 'BOOLEAN',
  },
  {
    name: 'LEFT',
    signature: 'LEFT(string, n)',
    description: 'Returns the first `n` characters of `string`.',
    returnType: 'CHARACTER',
  },
  {
    name: 'LENGTH',
    signature: 'LENGTH(string)',
    description: 'Returns the length of the string in characters.',
    returnType: 'INTEGER',
  },
  {
    name: 'LPAD',
    signature: 'LPAD(string, n, pad)',
    description: 'Left-pads `string` to length `n` using `pad`.',
    returnType: 'CHARACTER',
  },
  {
    name: 'LOWER',
    signature: 'LOWER(string)',
    description: 'Converts the string to lower case.',
    returnType: 'CHARACTER',
  },
  {
    name: 'LTRIM',
    signature: 'LTRIM(string)',
    description: 'Removes leading spaces from the string.',
    returnType: 'CHARACTER',
  },
  {
    name: 'OVERLAY',
    signature: 'OVERLAY(string PLACING replacement FROM start FOR length)',
    description: 'Replaces a portion of `string` with `replacement`.',
    returnType: 'CHARACTER',
  },
  {
    name: 'POSITION',
    signature: 'POSITION(search IN string)',
    description: 'Returns the position of the first occurrence of `search` in `string`, or 0 if not found.',
    returnType: 'INTEGER',
  },
  {
    name: 'REPLACE',
    signature: 'REPLACE(string, search, replacement)',
    description: 'Replaces all occurrences of `search` with `replacement` in `string`.',
    example: "REPLACE('Hello World', 'World', 'ESQL')",
    returnType: 'CHARACTER',
  },
  {
    name: 'REVERSE',
    signature: 'REVERSE(string)',
    description: 'Returns the string in reverse order.',
    returnType: 'CHARACTER',
  },
  {
    name: 'RIGHT',
    signature: 'RIGHT(string, n)',
    description: 'Returns the last `n` characters of `string`.',
    returnType: 'CHARACTER',
  },
  {
    name: 'RPAD',
    signature: 'RPAD(string, n, pad)',
    description: 'Right-pads `string` to length `n` using `pad`.',
    returnType: 'CHARACTER',
  },
  {
    name: 'RTRIM',
    signature: 'RTRIM(string)',
    description: 'Removes trailing spaces from the string.',
    returnType: 'CHARACTER',
  },
  {
    name: 'SPACE',
    signature: 'SPACE(n)',
    description: 'Returns a string of `n` spaces.',
    returnType: 'CHARACTER',
  },
  {
    name: 'STARTSWITH',
    signature: 'STARTSWITH(string, prefix)',
    description: 'Returns TRUE if `string` starts with `prefix`.',
    returnType: 'BOOLEAN',
  },
  {
    name: 'SUBSTRING',
    signature: 'SUBSTRING(string FROM start FOR length)',
    description:
      'Extracts a substring starting at `start` with `length` characters. Also supports SUBSTRING(string AFTER ...) and SUBSTRING(string BEFORE ...).',
    example: "SUBSTRING('Hello World' FROM 1 FOR 5) -- 'Hello'",
    returnType: 'CHARACTER',
  },
  {
    name: 'TRANSLATE',
    signature: 'TRANSLATE(string USING mapping)',
    description: 'Translates characters of `string` according to `mapping` (built with TRANSLATE VALUES).',
    returnType: 'CHARACTER',
  },
  {
    name: 'TRIM',
    signature: 'TRIM([LEADING|TRAILING|BOTH] [chars FROM] string)',
    description: 'Removes spaces (or the specified characters) from the edges of the string.',
    example: "TRIM('  hello  ') -- 'hello'",
    returnType: 'CHARACTER',
  },
  {
    name: 'UPPER',
    signature: 'UPPER(string)',
    description: 'Converts the string to upper case.',
    returnType: 'CHARACTER',
  },
  // Conversion
  {
    name: 'CAST',
    signature: "CAST(value AS datatype [FORMAT format])",
    description:
      'Converts a value to another data type. Supports FORMAT for date/time values.',
    example: "CAST('2024-01-15' AS DATE FORMAT 'yyyy-MM-dd')",
    returnType: 'specified datatype',
  },
  {
    name: 'ASBITSTREAM',
    signature:
      'ASBITSTREAM(tree CCSID c CHARACTER SET cs [BINARY|CHARACTER] [FORMAT f] [ENCODING e] [SET DOMAIN d] [PROPERTIES p])',
    description:
      'Serialises a message tree to a BLOB (the inverse of `BLOB AS BITSTREAM`). The grammar parses its clause form as a keyword call.',
    returnType: 'BLOB',
  },
  {
    name: 'COALESCE',
    signature: 'COALESCE(value1, value2, ...)',
    description: 'Returns the first non-NULL value in the list.',
    example: "COALESCE(InputRoot.JSON.Data.nombre, 'Sin nombre')",
    returnType: 'type of the first non-NULL argument',
  },
  {
    name: 'DECODE',
    signature: 'DECODE(value, search1, result1, ..., default)',
    description:
      'Returns resultN when value = searchN; returns `default` (or NULL) if no match.',
    returnType: 'type of the result arguments',
  },
  {
    name: 'NULLIF',
    signature: 'NULLIF(value1, value2)',
    description: 'Returns NULL if value1 = value2, otherwise returns value1.',
    returnType: 'type of value1 or NULL',
  },
  // Math
  { name: 'ABS', signature: 'ABS(number)', description: 'Returns the absolute value.', returnType: 'same type as the argument' },
  { name: 'ACOS', signature: 'ACOS(x)', description: 'Arccosine.', returnType: 'FLOAT' },
  { name: 'ASIN', signature: 'ASIN(x)', description: 'Arcsine.', returnType: 'FLOAT' },
  { name: 'ATAN', signature: 'ATAN(x)', description: 'Arctangent.', returnType: 'FLOAT' },
  { name: 'CEIL', signature: 'CEIL(x)', description: 'Rounds up to the nearest integer.', returnType: 'same type as the argument' },
  { name: 'COS', signature: 'COS(x)', description: 'Cosine.', returnType: 'FLOAT' },
  { name: 'EXP', signature: 'EXP(x)', description: 'Exponential (e^x).', returnType: 'FLOAT' },
  { name: 'FLOOR', signature: 'FLOOR(x)', description: 'Rounds down to the nearest integer.', returnType: 'same type as the argument' },
  { name: 'GREATEST', signature: 'GREATEST(a, b, ...)', description: 'Returns the largest argument.', returnType: 'type of the arguments' },
  { name: 'LEAST', signature: 'LEAST(a, b, ...)', description: 'Returns the smallest argument.', returnType: 'type of the arguments' },
  { name: 'LN', signature: 'LN(x)', description: 'Natural logarithm.', returnType: 'FLOAT' },
  { name: 'LOG', signature: 'LOG(x)', description: 'Logarithm base 10.', returnType: 'FLOAT' },
  {
    name: 'MOD',
    signature: 'MOD(dividend, divisor)',
    description: 'Returns the integer division remainder.',
    returnType: 'INTEGER',
  },
  { name: 'POWER', signature: 'POWER(base, exponent)', description: 'base raised to exponent.', returnType: 'FLOAT' },
  { name: 'RAND', signature: 'RAND()', description: 'Pseudo-random FLOAT in [0, 1).', returnType: 'FLOAT' },
  {
    name: 'ROUND',
    signature: 'ROUND(number, decimals)',
    description: 'Rounds a number to the given number of decimals.',
    returnType: 'DECIMAL',
  },
  { name: 'SIGN', signature: 'SIGN(x)', description: 'Returns -1, 0 or 1 depending on the sign of x.', returnType: 'INTEGER' },
  { name: 'SIN', signature: 'SIN(x)', description: 'Sine.', returnType: 'FLOAT' },
  { name: 'SQRT', signature: 'SQRT(x)', description: 'Square root.', returnType: 'FLOAT' },
  { name: 'TAN', signature: 'TAN(x)', description: 'Tangent.', returnType: 'FLOAT' },
  // Date/time
  {
    name: 'CURRENT_DATE',
    signature: 'CURRENT_DATE',
    description: 'Current system date.',
    returnType: 'DATE',
  },
  {
    name: 'CURRENT_TIME',
    signature: 'CURRENT_TIME',
    description: 'Current system time.',
    returnType: 'TIME',
  },
  {
    name: 'CURRENT_TIMESTAMP',
    signature: 'CURRENT_TIMESTAMP',
    description: 'Current system timestamp.',
    returnType: 'TIMESTAMP',
  },
  { name: 'CURRENT_GMTDATE', signature: 'CURRENT_GMTDATE', description: 'Current GMT date.', returnType: 'DATE' },
  { name: 'CURRENT_GMTTIME', signature: 'CURRENT_GMTTIME', description: 'Current GMT time.', returnType: 'TIME' },
  {
    name: 'CURRENT_GMTTIMESTAMP',
    signature: 'CURRENT_GMTTIMESTAMP',
    description: 'Current GMT timestamp.',
    returnType: 'TIMESTAMP',
  },
  {
    name: 'EXTRACT',
    signature: 'EXTRACT(part FROM datetime)',
    description: 'Extracts a part of a date/time value. Parts: YEAR, MONTH, DAY, HOUR, MINUTE, SECOND.',
    example: 'EXTRACT(YEAR FROM CURRENT_TIMESTAMP)',
    returnType: 'INTEGER',
  },
  {
    name: 'FORMAT_DATE',
    signature: "FORMAT_DATE(date USING FORMAT 'yyyy-MM-dd')",
    description: 'Formats a DATE value to a string using the given format.',
    returnType: 'CHARACTER',
  },
  {
    name: 'FORMAT_TIME',
    signature: "FORMAT_TIME(time USING FORMAT 'HH:mm:ss')",
    description: 'Formats a TIME value to a string using the given format.',
    returnType: 'CHARACTER',
  },
  {
    name: 'FORMAT_TIMESTAMP',
    signature: "FORMAT_TIMESTAMP(timestamp USING FORMAT 'yyyy-MM-dd HH:mm:ss')",
    description: 'Formats a TIMESTAMP value to a string using the given format.',
    returnType: 'CHARACTER',
  },
  // Message tree
  {
    name: 'CARDINALITY',
    signature: 'CARDINALITY(fieldReference[])',
    description: 'Returns the number of occurrences of a repetitive field (array).',
    example: 'CARDINALITY(InputRoot.XMLNSC.Root.Items.Item[])',
    returnType: 'INTEGER',
  },
  {
    name: 'EXISTS',
    signature: 'EXISTS(fieldReference[])',
    description: 'Returns TRUE if at least one instance of the field exists.',
    example: 'EXISTS(InputRoot.JSON.Data.field[])',
    returnType: 'BOOLEAN',
  },
  {
    name: 'FIELDNAME',
    signature: 'FIELDNAME(fieldReference)',
    description: 'Returns the name of the referenced field.',
    returnType: 'CHARACTER',
  },
  {
    name: 'FIELDNAMESPACE',
    signature: 'FIELDNAMESPACE(fieldReference)',
    description: 'Returns the namespace of the referenced field.',
    returnType: 'CHARACTER',
  },
  {
    name: 'FIELDTYPE',
    signature: 'FIELDTYPE(fieldReference)',
    description: 'Returns the type of the field (INTEGER, CHARACTER, ...).',
    returnType: 'INTEGER (type constant)',
  },
  {
    name: 'FIELDVALUE',
    signature: 'FIELDVALUE(fieldReference)',
    description:
      'Returns the value of a message tree field as a scalar. Useful when the reference may not exist (returns NULL instead of an exception).',
    example: 'FIELDVALUE(InputRoot.JSON.Data.field)',
    returnType: 'CHARACTER (or another scalar type)',
  },
  {
    name: 'LASTMOVE',
    signature: 'LASTMOVE(referenceVariable)',
    description: 'Returns TRUE if the last MOVE on the reference was successful.',
    returnType: 'BOOLEAN',
  },
  // Aggregates (used in SELECT over sets)
  {
    name: 'AVG',
    signature: 'AVG(set)',
    description: 'Average of a set of values. Used in SELECT statements over message tree sets.',
    returnType: 'DECIMAL',
  },
  {
    name: 'COUNT',
    signature: 'COUNT(set)',
    description: 'Number of values in the set. Used in SELECT statements over message tree sets.',
    returnType: 'INTEGER',
  },
  {
    name: 'MAX',
    signature: 'MAX(set)',
    description: 'Largest value in the set. Used in SELECT statements over message tree sets.',
    returnType: 'type of the set values',
  },
  {
    name: 'MIN',
    signature: 'MIN(set)',
    description: 'Smallest value in the set. Used in SELECT statements over message tree sets.',
    returnType: 'type of the set values',
  },
  {
    name: 'SUM',
    signature: 'SUM(set)',
    description: 'Sum of a set of values. Used in SELECT statements over message tree sets.',
    returnType: 'numeric type of the set values',
  },
  // UUID
  {
    name: 'UUIDASCHAR',
    signature: 'UUIDASCHAR()',
    description: 'Generates a unique UUID as a character string.',
    example: "UUIDASCHAR() -- '550e8400-e29b-41d4-a716-446655440000'",
    returnType: 'CHARACTER',
  },
  {
    name: 'UUIDASBLOB',
    signature: 'UUIDASBLOB()',
    description: 'Generates a unique UUID as a 16-byte BLOB.',
    returnType: 'BLOB',
  },
];
