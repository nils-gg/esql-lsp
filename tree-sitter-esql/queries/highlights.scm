; Highlights for ESQL (IBM App Connect Enterprise / IIB).
; Scope: source.esql

; ------------------------------------------------------------------
; Comments and literals
; ------------------------------------------------------------------

(comment) @comment
(line_comment) @comment

(string_literal) @string
(quoted_identifier) @string.special
(number_literal) @number
(blob_literal) @constant
(typed_literal) @constant

; ------------------------------------------------------------------
; Builtin values
; ------------------------------------------------------------------

(kw_NULL) @constant.builtin
(kw_TRUE) @constant.builtin
(kw_FALSE) @constant.builtin
(kw_UNKNOWN) @constant.builtin
(kw_NAN) @constant.builtin
(kw_INF) @constant.builtin
(kw_INFINITY) @constant.builtin
(kw_CURRENT_DATE) @constant.builtin
(kw_CURRENT_TIME) @constant.builtin
(kw_CURRENT_TIMESTAMP) @constant.builtin
(kw_CURRENT_GMTDATE) @constant.builtin
(kw_CURRENT_GMTTIME) @constant.builtin
(kw_CURRENT_GMTTIMESTAMP) @constant.builtin

; ------------------------------------------------------------------
; Control keywords
; ------------------------------------------------------------------

(kw_BEGIN) @keyword.control
(kw_END) @keyword.control
(kw_IF) @keyword.control
(kw_THEN) @keyword.control
(kw_ELSE) @keyword.control
(kw_ELSEIF) @keyword.control
(kw_CASE) @keyword.control
(kw_WHEN) @keyword.control
(kw_WHILE) @keyword.control
(kw_DO) @keyword.control
(kw_REPEAT) @keyword.control
(kw_UNTIL) @keyword.control
(kw_LOOP) @keyword.control
(kw_FOR) @keyword.control
(kw_ITERATE) @keyword.control
(kw_LEAVE) @keyword.control
(kw_RETURN) @keyword.control
(kw_RESIGNAL) @keyword.control
(kw_THROW) @keyword.control
(kw_USER) @keyword.control
(kw_EXCEPTION) @keyword.control
(kw_CONTINUE) @keyword.control
(kw_EXIT) @keyword.control
(kw_DECLARE) @keyword.control
(kw_HANDLER) @keyword.control
(kw_ATOMIC) @keyword.control
(kw_NOT) @keyword.control
(kw_AND) @keyword.control
(kw_OR) @keyword.control
(kw_IN) @keyword.control
(kw_BETWEEN) @keyword.control
(kw_LIKE) @keyword.control
(kw_IS) @keyword.control
(kw_ESCAPE) @keyword.control
(kw_ASYMMETRIC) @keyword.control
(kw_SYMMETRIC) @keyword.control
(kw_EXISTS) @keyword.control
(kw_SINGULAR) @keyword.control
(kw_EXTRACT) @keyword.control
(kw_FROM) @keyword.control
(kw_SELECT) @keyword.control
(kw_WHERE) @keyword.control
(kw_AS) @keyword.control
(kw_ITEM) @keyword.control
(kw_COUNT) @keyword.control
(kw_MAX) @keyword.control
(kw_MIN) @keyword.control
(kw_SUM) @keyword.control
(kw_INSERT) @keyword.control
(kw_CAST) @keyword.control
(kw_DEFAULT) @keyword.control

; ------------------------------------------------------------------
; Statement keywords
; ------------------------------------------------------------------

(kw_CREATE) @keyword
(kw_COMPUTE) @keyword
(kw_DATABASE) @keyword
(kw_FILTER) @keyword
(kw_DATABASEEVENT) @keyword
(kw_MODULE) @keyword
(kw_FUNCTION) @keyword
(kw_PROCEDURE) @keyword
(kw_SET) @keyword
(kw_CALL) @keyword
(kw_EVAL) @keyword
(kw_LOG) @keyword
(kw_EVENT) @keyword
(kw_TRACE) @keyword
(kw_FULL) @keyword
(kw_PROPAGATE) @keyword
(kw_PASSTHRU) @keyword
(kw_UPDATE) @keyword
(kw_DELETE) @keyword
(kw_ATTACH) @keyword
(kw_DETACH) @keyword
(kw_MOVE) @keyword
(kw_BROKER) @keyword
(kw_SCHEMA) @keyword
(kw_PATH) @keyword
(kw_VALUES) @keyword
(kw_INTO) @keyword
(kw_OF) @keyword
(kw_TO) @keyword
(kw_TERMINAL) @keyword
(kw_LABEL) @keyword
(kw_FINALIZE) @keyword
(kw_SEVERITY) @keyword
(kw_CATALOG) @keyword
(kw_MESSAGE) @keyword

; ------------------------------------------------------------------
; Clause keywords
; ------------------------------------------------------------------

(kw_INOUT) @keyword
(kw_OUT) @keyword
(kw_CONSTANT) @keyword
(kw_SHARED) @keyword
(kw_EXTERNAL) @keyword
(kw_NAMESPACE) @keyword
(kw_NAME) @keyword
(kw_VALUE) @keyword
(kw_TYPE) @keyword
(kw_DOMAIN) @keyword
(kw_FORMAT) @keyword
(kw_CCSID) @keyword
(kw_ENCODING) @keyword
(kw_OPTIONS) @keyword
(kw_IDENTITY) @keyword
(kw_PARSE) @keyword
(kw_SETS) @keyword
(kw_FIRSTCHILD) @keyword
(kw_LASTCHILD) @keyword
(kw_PREVIOUSSIBLING) @keyword
(kw_NEXTSIBLING) @keyword
(kw_PARENT) @keyword
(kw_LANGUAGE) @keyword
(kw_DYNAMIC) @keyword
(kw_RESULT) @keyword
(kw_ASSEMBLY) @keyword
(kw_APPDOMAIN) @keyword
(kw_VERSION) @keyword
(kw_CULTURE) @keyword
(kw_PUBLICKEYTOKEN) @keyword
(kw_CLASSLOADER) @keyword
(kw_ESQL) @keyword
(kw_JAVA) @keyword
(kw_CLR) @keyword
(kw_NULLABLE) @keyword
(kw_SQLSTATE) @keyword
(kw_ENVIRONMENT) @keyword

; ------------------------------------------------------------------
; Data types
; ------------------------------------------------------------------

(datatype) @type
(kw_BIT) @type
(kw_BLOB) @type
(kw_BOOLEAN) @type
(kw_CHAR) @type
(kw_CHARACTER) @type
(kw_VARCHAR) @type
(kw_DEC) @type
(kw_DECIMAL) @type
(kw_NUMERIC) @type
(kw_NUMBER) @type
(kw_NUM) @type
(kw_INT) @type
(kw_INTEGER) @type
(kw_FLOAT) @type
(kw_DATE) @type
(kw_TIME) @type
(kw_TIMESTAMP) @type
(kw_GMTTIME) @type
(kw_GMTTIMESTAMP) @type
(kw_INTERVAL) @type
(kw_ROW) @type
(kw_NAMEVALUE) @type
(kw_NONE) @type
(kw_REFERENCE) @type
(kw_YEAR) @type
(kw_MONTHS) @type
(kw_MONTH) @type
(kw_DAYOFYEAR) @type
(kw_DAYOFWEEK) @type
(kw_DAYS) @type
(kw_QUARTEROFYEAR) @type
(kw_QUARTERS) @type
(kw_WEEKS) @type
(kw_WEEKOFYEAR) @type
(kw_WEEKOFMONTH) @type
(kw_ISLEAPYEAR) @type
(kw_DAY) @type
(kw_HOUR) @type
(kw_MINUTE) @type
(kw_SECOND) @type

; ------------------------------------------------------------------
; Definitions and references
; ------------------------------------------------------------------

(create_module_statement (identifier) @module)
(create_routine_statement (identifier) @function.definition)
(declare_statement (identifier) @variable)
(routine_parameter (identifier) @parameter)
(function_call (identifier) @function.call)
(field_reference (identifier) @variable)
(schema_name (identifier) @module)
(label_before) @label
(label_end) @label

; ------------------------------------------------------------------
; Operators
; ------------------------------------------------------------------

["=" "<" ">" "<=" ">=" "<>" "||" "+" "-" "*" "/" "." "," "[" "]" "{" "}"] @operator
