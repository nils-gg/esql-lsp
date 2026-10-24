/**
 * Tree-sitter grammar for IBM ESQL
 * (App Connect Enterprise 12.0.x / WebSphere Message Broker).
 *
 * Every production is grounded in the IBM ACE 12.0.x ESQL reference
 * (syntax diagrams and examples). See VERIFICATION.md for the
 * construct-by-construct evidence table.
 *
 * Keyword handling:
 * - ESQL keywords are case-insensitive, so every keyword is a
 *   `token(prec(1, /WORD/i))` rule.
 * - Keywords beat `identifier` on equal-length matches (precedence 1
 *   vs 0); on unequal matches the longest match wins, so a variable
 *   named `countX` is still an identifier.
 * - Tree-sitter's lexer only tries tokens that are valid in the
 *   current parser state, so a keyword is recognised in keyword
 *   positions and read as an identifier in name positions (field
 *   reference names, DECLARE names, parameter names). This matches
 *   the spec: reserved keywords "can be used as names in a field
 *   reference" but not as variable names.
 *
 * Labels:
 * - A statement label is an identifier directly followed by `:`
 *   (before WHILE/REPEAT/LOOP/BEGIN) or by `;` (after END WHILE /
 *   END REPEAT / END LOOP / END, and after ITERATE/LEAVE). The
 *   trailing character is folded into the token because the
 *   tree-sitter lexer does not support regex lookahead.
 */

// This package is "type": "module", so the grammar file must be an ES module:
// tree-sitter-cli 0.27 loads grammar.js with import(), and `module.exports =`
// then dies with "module is not defined in ES module scope". `tree-sitter parse`
// and `tree-sitter test` keep working regardless, because they read src/.
export default grammar({
  name: 'esql',

  // CRITICAL: declare the word token. Without it, a keyword that is a
  // prefix of a longer word (e.g. kw_BIT inside "BITOR") wins over the
  // identifier, because keyword matching takes whole-word priority over
  // longest-match. With `word`, the lexer matches the full identifier
  // first and then recognizes it as a keyword only on an exact
  // whole-word match — so BITOR stays an identifier and BIT becomes
  // kw_BIT. (See tree-sitter docs: keyword extraction.)
  word: $ => $.identifier,

  extras: $ => [
    /\s+/,
    $.comment,
    $.line_comment,
  ],

  conflicts: $ => [
    // After a datatype, `(` may start a length/precision clause
    // (`CHAR(20)`) or an initial-value / call expression
    // (`DECLARE x BIT ROW('a')`); keep both parses open.
    [$.datatype],
    // Inside `SELECT ... FROM a, b`, a `,` after a from-item may extend
    // the from-list or (if the SELECT itself is an embedded expression)
    // terminate it; context decides.
    [$.select_expression],
    // `CAST (SELECT ... FROM a AS INT)` — after the from-item, `AS` may
    // be the item's alias or the CAST's type keyword; context decides.
    [$._from_item],
    // The unit production _complex_expr -> _concat_expr conflicts with
    // the IN / BETWEEN / LIKE / IS forms: after `x`, a keyword may start
    // a complex comparison or end the operand; context decides.
    [$._complex_expr],
    // After `INTERVAL 'x' DAY`, `TO` may start the `DAY TO HOUR` range or
    // end the (unit) qualifier; context decides.
    [$._interval_qualifier],
  ],

  rules: {
    // CRITICAL: tree-sitter uses the FIRST rule as the grammar root,
    // so source_file must stay first in this object.
    source_file: $ => seq(
      optional($.broker_schema_statement),
      repeat(choice(
        $.create_module_statement,
        $.create_routine_statement,
        $.declare_statement,
      )),
    ),

    // Case-insensitive keywords (named tokens, prec 1 beats identifier).
    kw_ATTACH: $ => token(prec(1, /ATTACH/i)),
    kw_AND: $ => token(prec(1, /AND/i)),
    kw_AS: $ => token(prec(1, /AS/i)),
    kw_ATOMIC: $ => token(prec(1, /ATOMIC/i)),
    kw_ASYMMETRIC: $ => token(prec(1, /ASYMMETRIC/i)),
    kw_BEGIN: $ => token(prec(1, /BEGIN/i)),
    kw_BETWEEN: $ => token(prec(1, /BETWEEN/i)),
    kw_BROKER: $ => token(prec(1, /BROKER/i)),
    kw_BIT: $ => token(prec(1, /BIT/i)),
    kw_BLOB: $ => token(prec(1, /BLOB/i)),
    kw_BOOLEAN: $ => token(prec(1, /BOOLEAN/i)),
    kw_CCSID: $ => token(prec(1, /CCSID/i)),
    kw_CHAR: $ => token(prec(1, /CHAR/i)),
    kw_CHARACTER: $ => token(prec(1, /CHARACTER/i)),
    kw_CALL: $ => token(prec(1, /CALL/i)),
    kw_CATALOG: $ => token(prec(1, /CATALOG/i)),
    kw_CASE: $ => token(prec(1, /CASE/i)),
    kw_CAST: $ => token(prec(1, /CAST/i)),
    kw_CLR: $ => token(prec(1, /CLR/i)),
    kw_COMPUTE: $ => token(prec(1, /COMPUTE/i)),
    kw_CONSTANT: $ => token(prec(1, /CONSTANT/i)),
    kw_CONTINUE: $ => token(prec(1, /CONTINUE/i)),
    kw_COUNT: $ => token(prec(1, /COUNT/i)),
    kw_CREATE: $ => token(prec(1, /CREATE/i)),
    kw_CURRENT_DATE: $ => token(prec(1, /CURRENT_DATE/i)),
    kw_CURRENT_GMTDATE: $ => token(prec(1, /CURRENT_GMTDATE/i)),
    kw_CURRENT_GMTTIME: $ => token(prec(1, /CURRENT_GMTTIME/i)),
    kw_CURRENT_GMTTIMESTAMP: $ => token(prec(1, /CURRENT_GMTTIMESTAMP/i)),
    kw_CURRENT_TIME: $ => token(prec(1, /CURRENT_TIME/i)),
    kw_CURRENT_TIMESTAMP: $ => token(prec(1, /CURRENT_TIMESTAMP/i)),
    kw_DATABASE: $ => token(prec(1, /DATABASE/i)),
    kw_DATABASEEVENT: $ => token(prec(1, /DATABASEEVENT/i)),
    kw_DATE: $ => token(prec(1, /DATE/i)),
    kw_DAY: $ => token(prec(1, /DAY/i)),
    kw_DAYS: $ => token(prec(1, /DAYS/i)),
    kw_DAYOFYEAR: $ => token(prec(1, /DAYOFYEAR/i)),
    kw_DAYOFWEEK: $ => token(prec(1, /DAYOFWEEK/i)),
    kw_DECLARE: $ => token(prec(1, /DECLARE/i)),
    kw_DEC: $ => token(prec(1, /DEC/i)),
    kw_DECIMAL: $ => token(prec(1, /DECIMAL/i)),
    kw_DEFAULT: $ => token(prec(1, /DEFAULT/i)),
    kw_DELETE: $ => token(prec(1, /DELETE/i)),
    kw_DETACH: $ => token(prec(1, /DETACH/i)),
    kw_DO: $ => token(prec(1, /DO/i)),
    kw_DOMAIN: $ => token(prec(1, /DOMAIN/i)),
    kw_DYNAMIC: $ => token(prec(1, /DYNAMIC/i)),
    kw_ELSE: $ => token(prec(1, /ELSE/i)),
    kw_ELSEIF: $ => token(prec(1, /ELSEIF/i)),
    kw_END: $ => token(prec(1, /END/i)),
    kw_ENCODING: $ => token(prec(1, /ENCODING/i)),
    kw_ENVIRONMENT: $ => token(prec(1, /ENVIRONMENT/i)),
    kw_ESCAPE: $ => token(prec(1, /ESCAPE/i)),
    kw_ESQL: $ => token(prec(1, /ESQL/i)),
    kw_EVAL: $ => token(prec(1, /EVAL/i)),
    kw_EVENT: $ => token(prec(1, /EVENT/i)),
    kw_EXCEPTION: $ => token(prec(1, /EXCEPTION/i)),
    kw_EXISTS: $ => token(prec(1, /EXISTS/i)),
    kw_EXTRACT: $ => token(prec(1, /EXTRACT/i)),
    kw_EXTERNAL: $ => token(prec(1, /EXTERNAL/i)),
    kw_ASSEMBLY: $ => token(prec(1, /ASSEMBLY/i)),
    kw_APPDOMAIN: $ => token(prec(1, /APPDOMAIN/i)),
    kw_CLASSLOADER: $ => token(prec(1, /CLASSLOADER/i)),
    kw_CULTURE: $ => token(prec(1, /CULTURE/i)),
    kw_PUBLICKEYTOKEN: $ => token(prec(1, /PUBLICKEYTOKEN/i)),
    kw_VERSION: $ => token(prec(1, /VERSION/i)),
    kw_EXIT: $ => token(prec(1, /EXIT/i)),
    kw_FALSE: $ => token(prec(1, /FALSE/i)),
    kw_FIELD: $ => token(prec(1, /FIELD/i)),
    kw_FILTER: $ => token(prec(1, /FILTER/i)),
    kw_FINALIZE: $ => token(prec(1, /FINALIZE/i)),
    kw_FIRSTCHILD: $ => token(prec(1, /FIRSTCHILD/i)),
    kw_FLOAT: $ => token(prec(1, /FLOAT/i)),
    kw_FOR: $ => token(prec(1, /FOR/i)),
    kw_FORMAT: $ => token(prec(1, /FORMAT/i)),
    kw_FROM: $ => token(prec(1, /FROM/i)),
    kw_FULL: $ => token(prec(1, /FULL/i)),
    kw_FUNCTION: $ => token(prec(1, /FUNCTION/i)),
    kw_GMTTIME: $ => token(prec(1, /GMTTIME/i)),
    kw_GMTTIMESTAMP: $ => token(prec(1, /GMTTIMESTAMP/i)),
    kw_HANDLER: $ => token(prec(1, /HANDLER/i)),
    kw_HOUR: $ => token(prec(1, /HOUR/i)),
    kw_IF: $ => token(prec(1, /IF/i)),
    kw_IDENTITY: $ => token(prec(1, /IDENTITY/i)),
    kw_IN: $ => token(prec(1, /IN/i)),
    kw_INF: $ => token(prec(1, /INF/i)),
    kw_INFINITY: $ => token(prec(1, /INFINITY/i)),
    kw_INSERT: $ => token(prec(1, /INSERT/i)),
    kw_INT: $ => token(prec(1, /INT/i)),
    kw_INTEGER: $ => token(prec(1, /INTEGER/i)),
    kw_INTERVAL: $ => token(prec(1, /INTERVAL/i)),
    kw_INTO: $ => token(prec(1, /INTO/i)),
    kw_INOUT: $ => token(prec(1, /INOUT/i)),
    kw_IS: $ => token(prec(1, /IS/i)),
    kw_ITEM: $ => token(prec(1, /ITEM/i)),
    kw_ISLEAPYEAR: $ => token(prec(1, /ISLEAPYEAR/i)),
    kw_ITERATE: $ => token(prec(1, /ITERATE/i)),
    kw_JAVA: $ => token(prec(1, /JAVA/i)),
    kw_LABEL: $ => token(prec(1, /LABEL/i)),
    kw_LAST: $ => token(prec(1, /LAST/i)),
    kw_LASTCHILD: $ => token(prec(1, /LASTCHILD/i)),
    kw_LANGUAGE: $ => token(prec(1, /LANGUAGE/i)),
    kw_LEAVE: $ => token(prec(1, /LEAVE/i)),
    kw_LIKE: $ => token(prec(1, /LIKE/i)),
    kw_LIST: $ => token(prec(1, /LIST/i)),
    kw_LOG: $ => token(prec(1, /LOG/i)),
    kw_LOOP: $ => token(prec(1, /LOOP/i)),
    kw_MAX: $ => token(prec(1, /MAX/i)),
    kw_MESSAGE: $ => token(prec(1, /MESSAGE/i)),
    kw_MIN: $ => token(prec(1, /MIN/i)),
    kw_MINUTE: $ => token(prec(1, /MINUTE/i)),
    kw_MODULE: $ => token(prec(1, /MODULE/i)),
    kw_MOVE: $ => token(prec(1, /MOVE/i)),
    kw_MONTH: $ => token(prec(1, /MONTH/i)),
    kw_MONTHS: $ => token(prec(1, /MONTHS/i)),
    kw_NAME: $ => token(prec(1, /NAME/i)),
    kw_NAMEVALUE: $ => token(prec(1, /NAMEVALUE/i)),
    kw_NAN: $ => token(prec(1, /NAN/i)),
    kw_NAMESPACE: $ => token(prec(1, /NAMESPACE/i)),
    kw_NEXTSIBLING: $ => token(prec(1, /NEXTSIBLING/i)),
    kw_NONE: $ => token(prec(1, /NONE/i)),
    kw_NOT: $ => token(prec(1, /NOT/i)),
    kw_NULL: $ => token(prec(1, /NULL/i)),
    kw_NULLABLE: $ => token(prec(1, /NULLABLE/i)),
    kw_NUM: $ => token(prec(1, /NUM/i)),
    kw_NUMBER: $ => token(prec(1, /NUMBER/i)),
    kw_NUMERIC: $ => token(prec(1, /NUMERIC/i)),
    kw_QUARTEROFYEAR: $ => token(prec(1, /QUARTEROFYEAR/i)),
    kw_QUARTERS: $ => token(prec(1, /QUARTERS/i)),
    kw_OF: $ => token(prec(1, /OF/i)),
    kw_OPTIONS: $ => token(prec(1, /OPTIONS/i)),
    kw_OR: $ => token(prec(1, /OR/i)),
    kw_OUT: $ => token(prec(1, /OUT/i)),
    kw_PARENT: $ => token(prec(1, /PARENT/i)),
    kw_PARSE: $ => token(prec(1, /PARSE/i)),
    kw_PATH: $ => token(prec(1, /PATH/i)),
    kw_PASSTHRU: $ => token(prec(1, /PASSTHRU/i)),
    kw_PREVIOUSSIBLING: $ => token(prec(1, /PREVIOUSSIBLING/i)),
    kw_PROCEDURE: $ => token(prec(1, /PROCEDURE/i)),
    kw_PROPAGATE: $ => token(prec(1, /PROPAGATE/i)),
    kw_REPEAT: $ => token(prec(1, /REPEAT/i)),
    kw_REFERENCE: $ => token(prec(1, /REFERENCE/i)),
    kw_RESIGNAL: $ => token(prec(1, /RESIGNAL/i)),
    kw_RETURN: $ => token(prec(1, /RETURN/i)),
    kw_RESULT: $ => token(prec(1, /RESULT/i)),
    kw_RETURNS: $ => token(prec(1, /RETURNS/i)),
    kw_ROW: $ => token(prec(1, /ROW/i)),
    kw_SCHEMA: $ => token(prec(1, /SCHEMA/i)),
    kw_SECOND: $ => token(prec(1, /SECOND/i)),
    kw_SELECT: $ => token(prec(1, /SELECT/i)),
    kw_SEVERITY: $ => token(prec(1, /SEVERITY/i)),
    kw_SET: $ => token(prec(1, /SET/i)),
    kw_SETS: $ => token(prec(1, /SETS/i)),
    kw_SHARED: $ => token(prec(1, /SHARED/i)),
    kw_SINGULAR: $ => token(prec(1, /SINGULAR/i)),
    kw_SQLSTATE: $ => token(prec(1, /SQLSTATE/i)),
    kw_SUM: $ => token(prec(1, /SUM/i)),
    kw_SYMMETRIC: $ => token(prec(1, /SYMMETRIC/i)),
    kw_TERMINAL: $ => token(prec(1, /TERMINAL/i)),
    kw_THEN: $ => token(prec(1, /THEN/i)),
    kw_THROW: $ => token(prec(1, /THROW/i)),
    kw_TIME: $ => token(prec(1, /TIME/i)),
    kw_TIMESTAMP: $ => token(prec(1, /TIMESTAMP/i)),
    kw_TO: $ => token(prec(1, /TO/i)),
    kw_TRACE: $ => token(prec(1, /TRACE/i)),
    kw_TRUE: $ => token(prec(1, /TRUE/i)),
    kw_TYPE: $ => token(prec(1, /TYPE/i)),
    kw_UNKNOWN: $ => token(prec(1, /UNKNOWN/i)),
    kw_UNTIL: $ => token(prec(1, /UNTIL/i)),
    kw_UPDATE: $ => token(prec(1, /UPDATE/i)),
    kw_USER: $ => token(prec(1, /USER/i)),
    kw_VALUE: $ => token(prec(1, /VALUE/i)),
    kw_VALUES: $ => token(prec(1, /VALUES/i)),
    kw_VARCHAR: $ => token(prec(1, /VARCHAR/i)),
    kw_VARYING: $ => token(prec(1, /VARYING/i)),
    kw_WHEN: $ => token(prec(1, /WHEN/i)),
    kw_WHERE: $ => token(prec(1, /WHERE/i)),
    kw_WHILE: $ => token(prec(1, /WHILE/i)),
    kw_WEEKS: $ => token(prec(1, /WEEKS/i)),
    kw_WEEKOFMONTH: $ => token(prec(1, /WEEKOFMONTH/i)),
    kw_WEEKOFYEAR: $ => token(prec(1, /WEEKOFYEAR/i)),
    kw_YEAR: $ => token(prec(1, /YEAR/i)),

    // A label: identifier + ':' (before a labelled statement) or
    // identifier + ';' (trailing label / ITERATE / LEAVE target).
    label_before: $ => token(prec(2, /[_a-zA-Z][_a-zA-Z0-9]*:/)),
    label_end: $ => token(prec(2, /[_a-zA-Z][_a-zA-Z0-9]*;/)),

    // ------------------------------------------------------------------
    // BROKER SCHEMA .mft.MySchema [PATH .a.b, .c.d] [;]
    broker_schema_statement: $ => seq(
      $.kw_BROKER, $.kw_SCHEMA,
      $.schema_name,
      optional(seq(
        $.kw_PATH,
        $.schema_name,
        repeat(seq(',', $.schema_name)),
      )),
      optional(';'),
    ),

    // Schema id: optional leading dot plus dotted identifiers,
    // e.g. `.mft.MySchema` or `mft.MySchema`.
    schema_name: $ => seq(
      optional('.'),
      $.identifier,
      repeat(seq('.', $.identifier)),
    ),

    // ------------------------------------------------------------------
    // Modules and routines
    // ------------------------------------------------------------------

    // CREATE (COMPUTE | DATABASE | FILTER | DATABASEEVENT) MODULE name;
    //   <routine | declare>*
    // END MODULE;
    create_module_statement: $ => seq(
      $.kw_CREATE,
      choice(
        $.kw_COMPUTE,
        $.kw_DATABASE,
        $.kw_FILTER,
        $.kw_DATABASEEVENT,
      ),
      $.kw_MODULE,
      $.identifier,
      // The `;` after the module name is explicitly optional in the
      // spec diagram (<<---;---<<); the terminator after END MODULE is
      // omitted from the diagram but present in all examples — accept
      // both (permissive superset).
      optional(';'),
      repeat(choice(
        $.create_routine_statement,
        $.declare_statement,
      )),
      $.kw_END, $.kw_MODULE, optional(';'),
    ),

    // CREATE (FUNCTION | PROCEDURE) name (params)
    //   [RETURNS type [NULLABLE | NOT NULL]]
    //   [LANGUAGE (ESQL | DATABASE | JAVA | CLR | .NET)]
    //   [DYNAMIC RESULT SETS n]
    //   ( body | EXTERNAL NAME "..." )
    //   ;
    create_routine_statement: $ => seq(
      $.kw_CREATE,
      choice($.kw_FUNCTION, $.kw_PROCEDURE),
      $.identifier,
      '(',
      optional(seq($.routine_parameter, repeat(seq(',', $.routine_parameter)))),
      ')',
      optional(seq(
        $.kw_RETURNS,
        $.datatype,
        optional(choice($.kw_NULLABLE, seq($.kw_NOT, $.kw_NULL))),
      )),
      optional(seq(
        $.kw_LANGUAGE,
        choice(
          $.kw_ESQL,
          $.kw_DATABASE,
          $.kw_JAVA,
          $.kw_CLR,
          $._dotnet,
        ),
      )),
      optional(seq(
        $.kw_DYNAMIC, $.kw_RESULT, $.kw_SETS, $.number_literal,
      )),
      choice(
        $.routine_body,
        seq(
          $.kw_EXTERNAL, $.kw_NAME,
          // Spec examples use double-quoted names; accept single-quoted
          // as well (permissive superset).
          choice($.string_literal, $.quoted_identifier),
          // .NET / Java clauses (CREATE FUNCTION spec page: ASSEMBLY group
          // + CLASSLOADER). Written as a repeat of a choice — the sequential
          // optional() chain is a known LR-construction pathology for this
          // grammar (bisection: 4 optionals generate in ~5 min, 5+ never
          // finish; repeat(choice) completes in ~8 min). Permissive
          // superset: clause order/repetition is unconstrained.
          repeat(choice(
            seq($.kw_ASSEMBLY, choice($.string_literal, $.quoted_identifier)),
            seq($.kw_APPDOMAIN, choice($.string_literal, $.quoted_identifier)),
            seq($.kw_VERSION, choice($.string_literal, $.quoted_identifier)),
            seq($.kw_CULTURE, choice($.string_literal, $.quoted_identifier)),
            seq($.kw_PUBLICKEYTOKEN, choice($.string_literal, $.quoted_identifier)),
            seq($.kw_CLASSLOADER, choice($.string_literal, $.quoted_identifier)),
          )),
        ),
      ),
      // The terminator is omitted from the spec diagram but present in
      // all examples — accept both (permissive superset).
      optional(';'),
    ),

    // [IN | OUT | INOUT] name [CONSTANT] type
    //   [NAMESPACE '...' | NAME '...'] [NULLABLE | NOT NULL]
    routine_parameter: $ => seq(
      optional(choice($.kw_IN, $.kw_OUT, $.kw_INOUT)),
      $.identifier,
      optional($.kw_CONSTANT),
      $.datatype,
      // Target of a REFERENCE TO parameter: the 12.0 CREATE FUNCTION
      // diagram shows a bare DataType leaf (spec example: `IN root
      // REFERENCE`), but IBM's long-standing examples use
      // `P1 REFERENCE TO InputRoot` in parameter lists — the target is a
      // field reference (path with . / [n] / quoted / * / :type parts).
      // Permissive superset: accepted after any datatype.
      optional($.field_reference),
      // Separate railroad boxes — both may appear (spec CREATE FUNCTION
      // Parameter diagram, note 2).
      optional(seq($.kw_NAMESPACE, $.string_literal)),
      optional(seq($.kw_NAME, $.string_literal)),
      optional(choice($.kw_NULLABLE, seq($.kw_NOT, $.kw_NULL))),
    ),

    // BEGIN [NOT ATOMIC] statement* END   (no trailing ';' — the
    // owning statement supplies it)
    routine_body: $ => seq(
      $.kw_BEGIN,
      optional(seq($.kw_NOT, $.kw_ATOMIC)),
      repeat($.esql_statement),
      $.kw_END,
    ),

    // .NET as a LANGUAGE value — the only ESQL token that starts with a
    // dot.
    _dotnet: $ => token(seq('.', /NET/i)),

    // ------------------------------------------------------------------
    // DECLARE
    // ------------------------------------------------------------------

    // DECLARE name (, name)* [SHARED] [EXTERNAL] [CONSTANT] type
    //   [NAMESPACE '...' | NAME '...'] [initial-expression] ;
    declare_statement: $ => seq(
      $.kw_DECLARE,
      $.identifier,
      repeat(seq(',', $.identifier)),
      optional($.kw_SHARED),
      optional($.kw_EXTERNAL),
      optional($.kw_CONSTANT),
      $.datatype,
      // Separate railroad boxes — both may appear (spec DECLARE diagram).
      optional(seq($.kw_NAMESPACE, $.string_literal)),
      optional(seq($.kw_NAME, $.string_literal)),
      optional($.expression),
      ';',
    ),

    // ------------------------------------------------------------------
    // Statements
    // ------------------------------------------------------------------

    esql_statement: $ => choice(
      $.block_statement,
      $.if_statement,
      $.case_statement,
      $.while_statement,
      $.repeat_statement,
      $.loop_statement,
      $.for_statement,
      $.iterate_statement,
      $.leave_statement,
      $.return_statement,
      $.resignal_statement,
      $.call_statement,
      $.eval_statement,
      $.log_statement,
      $.throw_statement,
      $.declare_statement,
      $.declare_handler_statement,
      $.set_statement,
      $.create_field_statement,
      $.delete_field_statement,
      $.attach_statement,
      $.detach_statement,
      $.move_statement,
      $.propagate_statement,
      $.passthru_statement,
      $.insert_statement,
      $.update_statement,
      $.delete_from_statement,
    ),

    // [label:] BEGIN [NOT ATOMIC] statement* END [label] ;
    block_statement: $ => seq(
      optional($.label_before),
      $.kw_BEGIN,
      optional(seq($.kw_NOT, $.kw_ATOMIC)),
      repeat($.esql_statement),
      $.kw_END,
      choice($.label_end, ';'),
    ),

    // IF expr THEN stmt+ [ELSEIF expr THEN stmt+]* [ELSE stmt+] END IF;
    if_statement: $ => seq(
      $.kw_IF, $.expression, $.kw_THEN,
      repeat1($.esql_statement),
      repeat(seq(
        $.kw_ELSEIF, $.expression, $.kw_THEN,
        repeat1($.esql_statement),
      )),
      optional(seq($.kw_ELSE, repeat1($.esql_statement))),
      $.kw_END, $.kw_IF, ';',
    ),

    // CASE [expr] WHEN e THEN stmt+ ... [ELSE stmt+] END CASE;
    case_statement: $ => seq(
      $.kw_CASE,
      optional($.expression),
      repeat1(seq(
        $.kw_WHEN, $.expression, $.kw_THEN,
        repeat1($.esql_statement),
      )),
      optional(seq($.kw_ELSE, repeat1($.esql_statement))),
      $.kw_END, $.kw_CASE, ';',
    ),

    // [label:] WHILE cond DO stmt+ END WHILE [label] ;
    while_statement: $ => seq(
      optional($.label_before),
      $.kw_WHILE, $.expression, $.kw_DO,
      repeat1($.esql_statement),
      $.kw_END, $.kw_WHILE,
      choice($.label_end, ';'),
    ),

    // [label:] REPEAT stmt+ UNTIL cond END REPEAT [label] ;
    repeat_statement: $ => seq(
      optional($.label_before),
      $.kw_REPEAT,
      repeat1($.esql_statement),
      $.kw_UNTIL, $.expression,
      $.kw_END, $.kw_REPEAT,
      choice($.label_end, ';'),
    ),

    // [label:] LOOP stmt+ END LOOP [label] ;
    loop_statement: $ => seq(
      optional($.label_before),
      $.kw_LOOP,
      repeat1($.esql_statement),
      $.kw_END, $.kw_LOOP,
      choice($.label_end, ';'),
    ),

    // FOR correlation AS field-reference DO stmt+ END FOR;
    for_statement: $ => seq(
      $.kw_FOR, $.identifier, $.kw_AS, $.field_reference, $.kw_DO,
      repeat1($.esql_statement),
      $.kw_END, $.kw_FOR, ';',
    ),

    // ITERATE [label] ;    LEAVE [label] ;
    iterate_statement: $ => seq($.kw_ITERATE, choice($.label_end, ';')),
    leave_statement: $ => seq($.kw_LEAVE, choice($.label_end, ';')),

    // RETURN [expr] ;    RESIGNAL ;
    return_statement: $ => seq($.kw_RETURN, optional($.expression), ';'),
    resignal_statement: $ => seq($.kw_RESIGNAL, ';'),

    // ------------------------------------------------------------------
    // Routine calls / logging / exceptions
    // ------------------------------------------------------------------

    // CALL [schema.]RoutineName (expr, ...)
    //   [IN Database.dsn[.schema] | EXTERNAL SCHEMA name]
    //   [INTO target] ;
    call_statement: $ => seq(
      $.kw_CALL,
      $.qualified_name,
      '(',
      optional(seq($.expression, repeat(seq(',', $.expression)))),
      ')',
      optional(choice(
        seq($.kw_IN, $.kw_DATABASE, '.', $._db_part,
            repeat(seq('.', $._db_part))),
        seq($.kw_EXTERNAL, $.kw_SCHEMA, $.identifier),
      )),
      optional(seq($.kw_INTO, $.field_reference)),
      ';',
    ),

    // A possibly schema-qualified routine name: [.]ident(.ident)*
    qualified_name: $ => seq(
      optional('.'),
      $.identifier,
      repeat(seq('.', $.identifier)),
    ),

    // A database source / schema / table part: an identifier or a
    // dynamic {expression}.
    _db_part: $ => choice(
      $.identifier,
      seq('{', $.expression, '}'),
    ),

    // EVAL (character-expression) ;   (also usable as an expression)
    eval_statement: $ => seq($.kw_EVAL, '(', $.expression, ')', ';'),

    // LOG (EVENT | USER TRACE) [FULL] [EXCEPTION]
    //   [SEVERITY e] [CATALOG e] [MESSAGE e]
    //   VALUES (e, ...) ;
    log_statement: $ => seq(
      $.kw_LOG,
      choice($.kw_EVENT, seq($.kw_USER, $.kw_TRACE)),
      optional($.kw_FULL),
      optional($.kw_EXCEPTION),
      optional(seq($.kw_SEVERITY, $.expression)),
      optional(seq($.kw_CATALOG, $.expression)),
      optional(seq($.kw_MESSAGE, $.expression)),
      $.kw_VALUES, '(',
      $.expression, repeat(seq(',', $.expression)),
      ')', ';',
    ),

    // THROW USER EXCEPTION
    //   [SEVERITY e] [CATALOG e] [MESSAGE e] [VALUES (e, ...)] ;
    throw_statement: $ => seq(
      $.kw_THROW, $.kw_USER, $.kw_EXCEPTION,
      optional(seq($.kw_SEVERITY, $.expression)),
      optional(seq($.kw_CATALOG, $.expression)),
      optional(seq($.kw_MESSAGE, $.expression)),
      optional(seq(
        $.kw_VALUES, '(',
        $.expression, repeat(seq(',', $.expression)),
        ')',
      )),
      ';',
    ),

    // DECLARE (CONTINUE | EXIT) HANDLER FOR SQLSTATE
    //   ('v' | VALUE 'v' | LIKE 'p' [ESCAPE 'e']) (, ...)* statement
    declare_handler_statement: $ => seq(
      $.kw_DECLARE,
      choice($.kw_CONTINUE, $.kw_EXIT),
      $.kw_HANDLER, $.kw_FOR, $.kw_SQLSTATE,
      $.sqlstate_value,
      repeat(seq(',', $.sqlstate_value)),
      $.esql_statement,
    ),

    sqlstate_value: $ => choice(
      seq(optional($.kw_VALUE), $.string_literal),
      seq(
        $.kw_LIKE, $.string_literal,
        optional(seq($.kw_ESCAPE, $.string_literal)),
      ),
    ),

    // ------------------------------------------------------------------
    // SET
    // ------------------------------------------------------------------

    // SET target (= expr
    //   | [TYPE e] [NAMESPACE e] [NAME e] [VALUE e]) ;
    // Each named clause accepts a bare expression or `= expr` (see
    // _set_clause_value).
    set_statement: $ => seq(
      $.kw_SET,
      $.field_reference,
      choice(
        seq('=', $.expression),
        seq(
          optional(seq($.kw_TYPE, $._set_clause_value)),
          optional(seq($.kw_NAMESPACE, $._set_clause_value)),
          optional(seq($.kw_NAME, $._set_clause_value)),
          optional(seq($.kw_VALUE, $._set_clause_value)),
        ),
      ),
      ';',
    ),

    // Value of a named SET clause. The official railroad shows `=` only
    // after VALUE, but the ACE ESQL compiler also accepts
    // `SET ref TYPE = expr` / `NAMESPACE = expr` / `NAME = expr` (widely
    // used in real flows, e.g. JSON type marking); accept both
    // (permissive superset).
    _set_clause_value: $ => choice(
      $.expression,
      seq('=', $.expression),
    ),

    // ------------------------------------------------------------------
    // Message-tree manipulation
    // ------------------------------------------------------------------

    // CREATE FIELD ref
    //   | CREATE (PREVIOUSSIBLING | NEXTSIBLING) OF ref [REPEAT]
    //   | CREATE (FIRSTCHILD | LASTCHILD) OF ref
    //   [AS alias] [DOMAIN e] [TYPE e] [NAMESPACE e] [NAME e]
    //   [IDENTITY (type)Ns:Name[n]] [VALUE e] [FROM ref]
    //   [PARSE (e (, e | CLAUSE e)*)] ;
    create_field_statement: $ => seq(
      $.kw_CREATE,
      choice(
        seq($.kw_FIELD, $.field_reference),
        seq(
          choice($.kw_PREVIOUSSIBLING, $.kw_NEXTSIBLING),
          $.kw_OF, $.field_reference,
        ),
        seq(
          choice($.kw_FIRSTCHILD, $.kw_LASTCHILD),
          $.kw_OF, $.field_reference,
        ),
      ),
      // AS (Alias | FieldReference | Variable) — a bare variable name is a
      // zero-path field reference.
      optional(seq($.kw_AS, $.field_reference)),
      optional(seq($.kw_DOMAIN, $.expression)),
      // REPEAT [VALUE e] — sits after the DOMAIN clause in the railroad.
      // (Spec note 2 restricts REPEAT to PREVIOUSSIBLING/NEXTSIBLING; that
      // is a usage restriction, not enforced here.)
      optional(seq($.kw_REPEAT, optional(seq($.kw_VALUE, $.expression)))),
      choice(
        // [TYPE e] [NAMESPACE e] [NAME e] [VALUE e] [TYPE e] [NAMESPACE e]
        // [NAME e] — names clauses may surround the VALUE clause.
        seq(
          optional(seq($.kw_TYPE, $.expression)),
          optional(seq($.kw_NAMESPACE, $.expression)),
          optional(seq($.kw_NAME, $.expression)),
          optional(seq($.kw_VALUE, $.expression)),
          optional(seq($.kw_TYPE, $.expression)),
          optional(seq($.kw_NAMESPACE, $.expression)),
          optional(seq($.kw_NAME, $.expression)),
        ),
        // IDENTITY takes a path element in place of the TYPE/NAME clauses;
        // a VALUE may still follow (per the spec examples).
        seq(
          $.kw_IDENTITY, $._identity_path,
          optional(seq($.kw_VALUE, $.expression)),
        ),
      ),
      optional(seq($.kw_FROM, $.field_reference)),
      optional($._parse_clause_group),
      ';',
    ),

    // PARSE ( bits [named clauses] | bits (, e)* ) — the two forms are
    // mutually exclusive alternatives (named clauses are juxtaposed, the
    // positional form is comma-separated and may be truncated).
    _parse_clause_group: $ => seq(
      $.kw_PARSE, '(',
      $.expression,
      choice(
        repeat($._parse_clause),
        repeat(seq(',', $.expression)),
      ),
      ')',
    ),

    // Named PARSE clause (alternative to the plain comma list).
    _parse_clause: $ => seq(
      choice(
        $.kw_ENCODING, $.kw_CCSID, $.kw_SET,
        $.kw_TYPE, $.kw_FORMAT, $.kw_OPTIONS,
      ),
      $.expression,
    ),

    // IDENTITY (Type[.Subtype]) [Ns:]Name[<index...>]
    // IDENTITY path element: ( SourceRef ) [TargetName [: Type]] [Index*]
    // where SourceRef is at most two dotted identifiers. The target name
    // is optional — `IDENTITY (JSON.Array)` appears in IBM's own examples
    // (the path element "contains (at most) a type, a namespace, a name,
    // and an index").
    _identity_path: $ => seq(
      '(',
      $.identifier,
      optional(seq('.', $.identifier)),
      ')',
      optional(seq(
        $.identifier,
        optional(seq(':', $.identifier)),
      )),
      repeat($._index_suffix),
    ),

    // DELETE (FIELD ref
    //   | (FIRSTCHILD | LASTCHILD | PREVIOUSSIBLING | NEXTSIBLING) OF ref) ;
    delete_field_statement: $ => seq(
      $.kw_DELETE,
      choice(
        seq($.kw_FIELD, $.field_reference),
        seq(
          choice(
            $.kw_FIRSTCHILD, $.kw_LASTCHILD,
            $.kw_PREVIOUSSIBLING, $.kw_NEXTSIBLING,
          ),
          $.kw_OF, $.field_reference,
        ),
      ),
      ';',
    ),

    // ATTACH ref TO ref AS (FIRSTCHILD | LASTCHILD | PREVIOUSSIBLING | NEXTSIBLING) ;
    attach_statement: $ => seq(
      $.kw_ATTACH, $.field_reference, $.kw_TO, $.field_reference, $.kw_AS,
      choice(
        $.kw_FIRSTCHILD, $.kw_LASTCHILD,
        $.kw_PREVIOUSSIBLING, $.kw_NEXTSIBLING,
      ),
      ';',
    ),

    // DETACH ref ;
    detach_statement: $ => seq($.kw_DETACH, $.field_reference, ';'),

    // MOVE target (TO ref
    //   | direction [REPEAT]
    //       (TYPE NAME
    //        | [TYPE e] [NAMESPACE e] [NAME e]
    //        | IDENTITY path)) ;
    move_statement: $ => seq(
      $.kw_MOVE, $.field_reference,
      choice(
        seq($.kw_TO, $.field_reference),
        seq(
          choice(
            $.kw_PARENT, $.kw_FIRSTCHILD, $.kw_LASTCHILD,
            $.kw_PREVIOUSSIBLING, $.kw_NEXTSIBLING,
          ),
          // NAME clauses (MOVE spec: TYPE expr / NAMESPACE (expr | *) /
          // NAME expr / IDENTITY path / REPEAT [TYPE [NAME]]).
          // Any order, each at most implied — permissive superset of the
          // railroad order. TYPE accepts the bare NAME keyword as its
          // value because "Name" (an XMLNSC type name) lexes as the
          // case-insensitive NAME keyword (spec example:
          // `MOVE cursor FIRSTCHILD TYPE Name NAME 'Field1'`).
          repeat(choice(
            seq($.kw_TYPE, choice($.expression, $.kw_NAME)),
            seq($.kw_NAMESPACE, choice($.expression, '*')),
            seq($.kw_NAME, $.expression),
            seq($.kw_IDENTITY, $._identity_path),
          )),
          // REPEAT [TYPE [NAME]] — the "same type/name" flag form; a
          // single trailing box in the spec railroad (not part of the
          // repeating NAME-clause group). REPEAT-only-with-siblings is
          // enforced at the semantic level; accepted permissively with
          // any direction.
          optional(seq($.kw_REPEAT, optional(seq($.kw_TYPE, optional($.kw_NAME))))),
        ),
      ),
      ';',
    ),

    // ------------------------------------------------------------------
    // Propagation / passthru
    // ------------------------------------------------------------------

    // PROPAGATE [TO (TERMINAL e | LABEL e)]
    //   [WHERE (ENVIRONMENT | MESSAGE | EXCEPTION) e]
    //   [FINALIZE (DEFAULT | NONE)] [DELETE (DEFAULT | NONE)] ;
    propagate_statement: $ => seq(
      $.kw_PROPAGATE,
      optional(seq(
        $.kw_TO,
        choice(
          seq($.kw_TERMINAL, $.expression),
          seq($.kw_LABEL, $.expression),
        ),
      )),
      optional(seq(
        $.kw_WHERE,
        choice($.kw_ENVIRONMENT, $.kw_MESSAGE, $.kw_EXCEPTION),
        $.expression,
      )),
      optional(seq($.kw_FINALIZE, choice($.kw_DEFAULT, $.kw_NONE))),
      optional(seq($.kw_DELETE, choice($.kw_DEFAULT, $.kw_NONE))),
      ';',
    ),

    // PASSTHRU expr [TO Database.dsn] [VALUES (e, ...)] ;
    passthru_statement: $ => seq(
      $.kw_PASSTHRU,
      choice(
        $.expression,
        // Backward-compatibility form (12.0 PASSTHRU diagram, note 1):
        // a parenthesized two-or-more expression list.
        seq('(', $.expression, ',',
            $.expression, repeat(seq(',', $.expression)), ')'),
      ),
      optional(seq($.kw_TO, $.kw_DATABASE, '.', $._db_part)),
      optional(seq(
        $.kw_VALUES, '(',
        $.expression, repeat(seq(',', $.expression)),
        ')',
      )),
      ';',
    ),

    // ------------------------------------------------------------------
    // Database statements
    // ------------------------------------------------------------------

    // INSERT INTO Database[.ds][.schema][.table] (col, ...) VALUES (e, ...) ;
    insert_statement: $ => seq(
      $.kw_INSERT, $.kw_INTO, $.table_reference,
      '(',
      $.identifier, repeat(seq(',', $.identifier)),
      ')',
      $.kw_VALUES, '(',
      $.expression, repeat(seq(',', $.expression)),
      ')',
      optional(seq($.kw_WHERE, $.expression)),
      ';',
    ),

    // UPDATE Database[.ds][.schema][.table] [AS corr]
    //   SET col = e (, col = e)* [WHERE e] ;
    update_statement: $ => seq(
      $.kw_UPDATE, $.table_reference,
      optional(seq($.kw_AS, $.identifier)),
      $.kw_SET, $.identifier, '=', $.expression,
      repeat(seq(',', $.identifier, '=', $.expression)),
      optional(seq($.kw_WHERE, $.expression)),
      ';',
    ),

    // DELETE FROM Database[.ds][.schema][.table] [AS corr] [WHERE e] ;
    delete_from_statement: $ => seq(
      $.kw_DELETE, $.kw_FROM, $.table_reference,
      optional(seq($.kw_AS, $.identifier)),
      optional(seq($.kw_WHERE, $.expression)),
      ';',
    ),

    // Database reference: Database . part [. part] [. part] where each
    // part is a data-source / schema / table name (or {dynamic expr}).
    table_reference: $ => seq(
      $.kw_DATABASE, '.', $._db_part,
      optional(seq('.', $._db_part)),
      optional(seq('.', $._db_part)),
    ),

    // ------------------------------------------------------------------
    // Expressions
    //
    // Precedence (loosest to tightest), per the ESQL operator rules:
    //   OR  <  AND  <  NOT  <  simple comparison (= < > <= >= <>)
    //   <  complex comparison (IN BETWEEN LIKE IS NULL)
    //   <  ||  <  + -  <  * /  <  unary + -
    // There is no modulo operator in ESQL.
    // ------------------------------------------------------------------

    expression: $ => $._or_expr,

    _or_expr: $ => prec.right(1, choice(
      $._and_expr,
      seq($._or_expr, $.kw_OR, $._and_expr),
    )),

    _and_expr: $ => prec.right(2, choice(
      $._not_expr,
      seq($._and_expr, $.kw_AND, $._not_expr),
    )),

    _not_expr: $ => prec(3, choice(
      $._comparison_expr,
      seq($.kw_NOT, $._not_expr),
    )),

    _comparison_expr: $ => prec.left(4, choice(
      $._complex_expr,
      seq(
        $._complex_expr,
        choice('=', '<', '>', '<=', '>=', '<>'),
        $._complex_expr,
      ),
    )),

    // Complex comparisons (ESQL complex comparison operators spec page):
    //   e [NOT] IN ( e (, e)* )
    //   e [NOT] BETWEEN [ASYMMETRIC | SYMMETRIC] e AND e
    //   e [NOT] LIKE e [ESCAPE e]
    //   e IS [NOT] { NULL | TRUE | FALSE | INF | +INF | -INF | INFINITY
    //                | +INFINITY | -INFINITY | NAN | NUM | NUMBER | UNKNOWN }
    _complex_expr: $ => prec(5, choice(
      $._concat_expr,
      seq(
        $._concat_expr, optional($.kw_NOT), $.kw_IN, '(',
        $.expression, repeat(seq(',', $.expression)),
        ')',
      ),
      seq(
        $._concat_expr, optional($.kw_NOT), $.kw_BETWEEN,
        optional(choice($.kw_ASYMMETRIC, $.kw_SYMMETRIC)),
        $._concat_expr,
        $.kw_AND, $._concat_expr,
      ),
      seq(
        $._concat_expr, optional($.kw_NOT), $.kw_LIKE, $._concat_expr,
        optional(seq($.kw_ESCAPE, $._concat_expr)),
      ),
      seq(
        $._concat_expr, $.kw_IS, optional($.kw_NOT), $._is_value,
      ),
    )),

    // Value set of the IS operator.
    _is_value: $ => choice(
      $.kw_NULL,
      $.kw_TRUE,
      $.kw_FALSE,
      $.kw_UNKNOWN,
      $.kw_INF,
      seq(choice('+', '-'), $.kw_INF),
      $.kw_INFINITY,
      seq(choice('+', '-'), $.kw_INFINITY),
      $.kw_NAN,
      $.kw_NUM,
      $.kw_NUMBER,
    ),

    _concat_expr: $ => prec.left(6, choice(
      $._additive_expr,
      seq($._concat_expr, '||', $._concat_expr),
    )),

    _additive_expr: $ => prec.left(7, choice(
      $._multiplicative_expr,
      seq($._additive_expr, choice('+', '-'), $._multiplicative_expr),
    )),

    _multiplicative_expr: $ => prec.left(8, choice(
      $._unary_expr,
      seq($._multiplicative_expr, choice('*', '/'), $._multiplicative_expr),
    )),

    _unary_expr: $ => prec(9, choice(
      $.primary_expression,
      seq(choice('-', '+'), $._unary_expr),
    )),

    primary_expression: $ => choice(
      $.string_literal,
      $.number_literal,
      $.blob_literal,
      $.typed_literal,
      $.kw_NULL,
      $.kw_TRUE,
      $.kw_FALSE,
      $.kw_CURRENT_DATE,
      $.kw_CURRENT_TIME,
      $.kw_CURRENT_TIMESTAMP,
      $.kw_CURRENT_GMTDATE,
      $.kw_CURRENT_GMTTIME,
      $.kw_CURRENT_GMTTIMESTAMP,
      $.extract_expression,
      $.exists_expression,
      $.singular_expression,
      $.field_reference,
      $.function_call,
      $.select_expression,
      $.case_expression,
      $.cast_expression,
      $.row_constructor,
      $.list_constructor,
      seq('(', $.expression, ')'),
    ),

    // ------------------------------------------------------------------
    // Field references
    //
    // CorrelationName . PathElement*
    // PathElement := . [(TypeClause)] [Name | {expr} | * | :Name | Ns:Name | Ns:*]
    //                [[n] | [*] | [] | [<n] | [>n] | [<] | [>] | [LAST]]
    // TypeClause  := ( [Ns.]Type )  — e.g. (XML.Element), (.Attribute)
    // ------------------------------------------------------------------

    field_reference: $ => seq(
      choice($.identifier, $.quoted_identifier),
      repeat($._path_element),
    ),

    _path_element: $ => seq(
      '.',
      optional($._type_clause),
      $._path_name,
      repeat($._index_suffix),
    ),

    // Type clause: restricts the path to fields of the given type
    // (field reference overview, IBM ACE 12.0.x). Forms:
    //   (XML.Element)  — namespace-qualified type
    //   (.Attribute)   — leading dot: notarget namespace
    //   (Element)      — bare type name
    // The parts are names (identifiers, quoted names, or dynamic {expr})
    // — the type expression is a reference into the domain constant tree.
    _type_clause: $ => seq(
      '(',
      optional($._type_clause_part),
      optional(seq('.', $._type_clause_part)),
      ')',
    ),

    _type_clause_part: $ => choice(
      $.identifier,
      $.quoted_identifier,
      seq('{', $.expression, '}'),
    ),

    _path_name: $ => choice(
      // :Name | :* — notarget namespace
      seq(':', choice($._path_name_part, '*')),
      // Name | * | Ns:Name | Ns:* | *:Name | *:*
      // (the field reference summary lists all of these; *:* is
      // equivalent to * and matches any namespace)
      seq(
        $._path_name_any,
        optional(seq(':', choice($._path_name_part, '*'))),
      ),
    ),

    _path_name_any: $ => choice(
      '*',
      $._path_name_part,
    ),

    _path_name_part: $ => choice(
      $.identifier,
      $.quoted_identifier,
      seq('{', $.expression, '}'),
    ),

    _index_suffix: $ => seq(
      '[',
      optional(choice(
        '*',
        $.kw_LAST,
        seq('<', optional($.expression)),
        seq('>', optional($.expression)),
        $.expression,
      )),
      ']',
    ),

    // ------------------------------------------------------------------
    // Function calls and complex function forms
    // ------------------------------------------------------------------

    // identifier ( [expr | *] (, expr | *)* )
    // EXTRACT ( YEAR | MONTH | DAY | HOUR | MINUTE | SECOND | DAYS |
    // DAYOFYEAR | DAYOFWEEK | MONTHS | QUARTEROFYEAR | QUARTERS | WEEKS |
    // WEEKOFYEAR | WEEKOFMONTH | ISLEAPYEAR FROM SourceDate )
    // (ESQL EXTRACT function spec page).
    extract_expression: $ => seq(
      $.kw_EXTRACT, '(',
      choice(
        $.kw_YEAR, $.kw_MONTH, $.kw_DAY, $.kw_HOUR, $.kw_MINUTE,
        $.kw_SECOND, $.kw_DAYS, $.kw_DAYOFYEAR, $.kw_DAYOFWEEK,
        $.kw_MONTHS, $.kw_QUARTEROFYEAR, $.kw_QUARTERS, $.kw_WEEKS,
        $.kw_WEEKOFYEAR, $.kw_WEEKOFMONTH, $.kw_ISLEAPYEAR,
      ),
      $.kw_FROM,
      $.expression,
      ')',
    ),

    // EXISTS ( ListExpression ) — TRUE if the SELECT returned one or
    // more values (ESQL complex comparison operators spec page).
    exists_expression: $ => seq(
      $.kw_EXISTS, '(', $.expression, ')',
    ),

    // SINGULAR ( ListExpression ) — TRUE if the list has exactly one
    // element (ESQL complex comparison operators spec page).
    singular_expression: $ => seq(
      $.kw_SINGULAR, '(', $.expression, ')',
    ),

    function_call: $ => seq(
      $.identifier,
      '(',
      optional(seq($._call_arg, repeat(seq(',', $._call_arg)))),
      ')',
    ),

    _call_arg: $ => choice('*', $.expression),

    // SELECT item (, item)* FROM from-item (, from-item)* [WHERE e]
    //
    // item := * | ITEM e | INSERT e | (COUNT|MAX|MIN|SUM)( * | e ) | e
    // from-item := field-reference [AS corr]
    //
    // (No ORDER BY / GROUP BY / HAVING / DISTINCT / AVG in ESQL.)
    select_expression: $ => seq(
      $.kw_SELECT,
      $._select_item, repeat(seq(',', $._select_item)),
      $.kw_FROM,
      $._from_item, repeat(seq(',', $._from_item)),
      optional(seq($.kw_WHERE, $.expression)),
    ),

    _select_item: $ => choice(
      '*',
      seq($.kw_ITEM, $.expression),
      seq(
        choice($.kw_COUNT, $.kw_MAX, $.kw_MIN, $.kw_SUM),
        '(', $._call_arg, ')',
      ),
      seq($.kw_INSERT, $.expression),
      $.expression,
    ),

    _from_item: $ => seq(
      $.field_reference,
      optional(seq($.kw_AS, $.identifier)),
    ),

    // CASE [source] WHEN e THEN (e | NULL) ... [ELSE (e | NULL)] END
    case_expression: $ => seq(
      $.kw_CASE,
      optional($.expression),
      repeat1(seq($.kw_WHEN, $.expression, $.kw_THEN, $._case_value)),
      optional(seq($.kw_ELSE, $._case_value)),
      $.kw_END,
    ),

    // NULL is already reachable through expression -> primary_expression,
    // so keep this a pure alias to avoid a reduce/reduce conflict.
    _case_value: $ => $.expression,

    // CAST (e (, e)* AS type [CCSID e] [ENCODING e] [FORMAT e] [DEFAULT e])
    cast_expression: $ => seq(
      $.kw_CAST, '(',
      $.expression, repeat(seq(',', $.expression)),
      $.kw_AS, $.datatype,
      optional(seq($.kw_CCSID, $.expression)),
      optional(seq($.kw_ENCODING, $.expression)),
      optional(seq($.kw_FORMAT, $.expression)),
      optional(seq($.kw_DEFAULT, $.expression)),
      ')',
    ),

    // ROW (e [AS name] (, e [AS name])*)
    row_constructor: $ => seq(
      $.kw_ROW, '(',
      $._row_element, repeat(seq(',', $._row_element)),
      ')',
    ),

    _row_element: $ => seq(
      $.expression,
      optional(seq($.kw_AS, $.field_reference)),
    ),

    // LIST { e (, e)* }     (note the curly braces)
    list_constructor: $ => seq(
      $.kw_LIST, '{',
      $.expression, repeat(seq(',', $.expression)),
      '}',
    ),

    // ------------------------------------------------------------------
    // Data types
    // ------------------------------------------------------------------

    datatype: $ => seq(
      choice(
        $.kw_BIT, $.kw_BLOB, $.kw_BOOLEAN, $.kw_FLOAT,
        seq(choice($.kw_CHAR, $.kw_CHARACTER), optional($.kw_VARYING)),
        $.kw_VARCHAR, $.kw_DECIMAL, $.kw_DEC, $.kw_NUMERIC,
        $.kw_INTEGER, $.kw_INT,
        $.kw_DATE, $.kw_TIME, $.kw_TIMESTAMP, $.kw_GMTTIME,
        $.kw_GMTTIMESTAMP,
        seq($.kw_INTERVAL, $._interval_qualifier),
        $.kw_ROW, $.kw_NAME, $.kw_NAMEVALUE, $.kw_NONE,
        $.kw_REFERENCE,
        seq($.kw_REFERENCE, $.kw_TO),
      ),
      optional(seq(
        '(',
        $.number_literal,
        optional(seq(',', $.number_literal)),
        ')',
      )),
    ),

    _interval_qualifier: $ => choice(
      seq($.kw_YEAR, optional(seq($.kw_TO, $.kw_MONTH))),
      $.kw_MONTH,
      seq($.kw_DAY, optional(seq($.kw_TO, choice($.kw_HOUR, $.kw_MINUTE, $.kw_SECOND)))),
      seq($.kw_HOUR, optional(seq($.kw_TO, choice($.kw_MINUTE, $.kw_SECOND)))),
      seq($.kw_MINUTE, optional(seq($.kw_TO, $.kw_SECOND))),
      $.kw_SECOND,
    ),

    // ------------------------------------------------------------------
    // Literals
    // ------------------------------------------------------------------

    // Unquoted name: letter or underscore, then letters/digits/underscores.
    identifier: $ => /[_a-zA-Z][_a-zA-Z0-9]*/,

    // 'text' with '' escaping.
    string_literal: $ => /'([^']|'')*'/,

    // "identifier" with "" escaping (quoted field-reference name).
    quoted_identifier: $ => /"([^"]|"")*"/,

    // Decimal (0, 5, 2.5, 1e10, 1.5E-3) or hexadecimal (0x1F) integer.
    number_literal: $ => choice(
      /0[xX][0-9a-fA-F]+/,
      /[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/,
    ),

    // X'FF00' BLOB literal.
    blob_literal: $ => /[xX]'[0-9a-fA-F]*'/,

    // Typed literals:
    //   DATE '2024-01-01', TIME '10:00:00', TIMESTAMP '...',
    //   GMTTIME '...', GMTTIMESTAMP '...', BIT '0101', CHAR 'a'
    //   INTERVAL '1-2' YEAR TO MONTH  (etc.)
    typed_literal: $ => choice(
      seq(
        choice(
          $.kw_DATE, $.kw_TIME, $.kw_TIMESTAMP,
          $.kw_GMTTIME, $.kw_GMTTIMESTAMP,
          $.kw_BIT, $.kw_CHAR, $.kw_CHARACTER,
        ),
        $.string_literal,
      ),
      seq($.kw_INTERVAL, $.string_literal, $._interval_qualifier),
    ),

    // ------------------------------------------------------------------
    // Comments
    // ------------------------------------------------------------------

    // /* … */ — and it must stop at its OWN terminator.
    //
    // A lazy quantifier cannot express that here: tree-sitter compiles a token
    // regex into a DFA that takes the leftmost-LONGEST match, so
    //   /\/\*[\s\S]*?\*\//
    // did not behave lazily at all — one comment token ran from the first /* to
    // the LAST */ in the file, hiding every statement in between from the
    // parser (151 lines in one real file) while producing no ERROR node to
    // report it (ISSUES.md I-2). This is the classic C-comment shape: after the
    // opener, repeatedly take a non-`*` or a run of `*` followed by something
    // that is neither `*` nor `/`, then the closing run of `*` and the `/`.
    // `*/` therefore cannot occur inside the token, and an unterminated /* is
    // left as an error rather than silently eating the rest of the file.
    comment: $ => /\/\*(?:[^*]|\*+[^*/])*\*+\//,

    // -- to end of line. `\r` ends it too: a client's line does not include its
    // terminator, so a token that swallowed the `\r` of a CRLF file was painted
    // one column past the end of the line (ISSUES.md I-18). A lone `\r` still
    // does not make tree-sitter start a new line — that limitation is I-19, not
    // something a token regex can fix.
    line_comment: $ => /--[^\r\n]*/,

  },
});
