#!/usr/bin/env bash
# One-shot generator of the ACE differential probe fixtures (kept as the
# source of the checked-in files; the .esql files are committed, run.js reads
# them, this script only regenerates them when a verdict is re-established).
set -eu
OUT="$(dirname "$0")/probes"
rm -rf "$OUT"; mkdir -p "$OUT"
mk(){ printf '%b\n' "$2" > "$OUT/$1"; }

# ---- forms ACE 13.0.9.0 COMPILES (expected ace=accept, ts=accept) ----------
mk ok_mod_header_no_semi.esql 'CREATE COMPUTE MODULE A\nEND MODULE;\n'
mk ok_body_end_semi.esql 'CREATE COMPUTE MODULE B\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_module_level_declare_multi.esql 'CREATE COMPUTE MODULE C\nDECLARE a, b CHARACTER(50);\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_declare_multi_name_routine.esql 'CREATE COMPUTE MODULE D\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE a, b INTEGER;\n  SET a = 1;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_declare_constant_row.esql 'CREATE COMPUTE MODULE E\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE r CONSTANT ROW;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_declare_namespace_alias.esql 'CREATE COMPUTE MODULE F\nDECLARE s1 NAMESPACE '"'"'http://x'"'"';\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_declare_name_alias.esql 'CREATE COMPUTE MODULE G\nDECLARE Schema1 NAME '"'"'Joe'"'"';\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_declare_quoted_name.esql 'CREATE COMPUTE MODULE H\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE "odd name" INTEGER;\n  SET "odd name" = 1;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_returns_nullable.esql 'CREATE COMPUTE MODULE I\nCREATE FUNCTION F() RETURNS INT NULLABLE\nBEGIN\n  RETURN 1;\nEND;\nEND MODULE;\n'
mk ok_returns_not_null.esql 'CREATE COMPUTE MODULE J\nCREATE FUNCTION G() RETURNS INT NOT NULL\nBEGIN\n  RETURN 1;\nEND;\nEND MODULE;\n'
mk ok_param_reference_plain.esql 'CREATE COMPUTE MODULE K\nCREATE PROCEDURE P(IN root REFERENCE, OUT r2 REFERENCE)\nBEGIN\nEND;\nEND MODULE;\n'
mk ok_param_constant.esql 'CREATE COMPUTE MODULE L\nCREATE FUNCTION F(IN b CONSTANT INTEGER) RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_param_out_decimal.esql 'CREATE COMPUTE MODULE M\nCREATE FUNCTION F(OUT b DECIMAL) RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_handler_two_sqlstate.esql 'CREATE COMPUTE MODULE N\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE CONTINUE HANDLER FOR SQLSTATE '"'"'05001'"'"', SQLSTATE '"'"'05002'"'"'\n  SET Environment.Variable.Note = '"'"'h'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_set_type_equals.esql 'CREATE COMPUTE MODULE O\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  SET OutputRoot.Data.Item TYPE = '"'"'JSON.Array'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_set_namespace_equals.esql 'CREATE COMPUTE MODULE P\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  SET OutputRoot.Data.Item NAMESPACE = '"'"'http://x'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_set_value_equals.esql 'CREATE COMPUTE MODULE Q\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  SET OutputRoot.Data.Item VALUE = 1;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_set_name_equals.esql 'CREATE COMPUTE MODULE R\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  SET OutputRoot.Data.Item NAME = '"'"'Item'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_move_variable_source.esql 'CREATE COMPUTE MODULE S\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE r ROW;\n  MOVE r TO OutputRoot.XMLNS.c;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_log_event_values.esql 'CREATE COMPUTE MODULE T\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  LOG EVENT VALUES (1);\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_log_user_trace_bare.esql 'CREATE COMPUTE MODULE U\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  LOG USER TRACE;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_log_user_trace_values.esql 'CREATE COMPUTE MODULE U2\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  LOG USER TRACE VALUES ('"'"'m'"'"');\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_log_ut_message_values.esql 'CREATE COMPUTE MODULE V\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  LOG USER TRACE MESSAGE 2951 VALUES (1);\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_log_ut_full_exception_values.esql 'CREATE COMPUTE MODULE W\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  LOG USER TRACE FULL EXCEPTION VALUES (1);\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_select_count.esql 'CREATE COMPUTE MODULE X\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE n INTEGER;\n  SET n = SELECT COUNT(*) FROM InputRoot.XMLNS.Data.Item[];\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_insert_plain.esql 'CREATE COMPUTE MODULE Y\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  INSERT INTO Database.tab (a) VALUES (1);\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_set_date_literal.esql 'CREATE COMPUTE MODULE Z\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE d DATE;\n  SET d = DATE '"'"'2024-01-01'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_set_interval_literal.esql 'CREATE COMPUTE MODULE Z1\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE iv INTERVAL;\n  SET iv = INTERVAL '"'"'1-2'"'"' YEAR TO MONTH;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk ok_set_gmttime_literal.esql 'CREATE COMPUTE MODULE Z2\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE g GMTTIME;\n  SET g = GMTTIME '"'"'10:00:00'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'

# ---- forms ACE 13.0.9.0 REJECTS (ts verdict from manifest) ------------------
mk no_mod_header_trailing_semi.esql 'CREATE COMPUTE MODULE N1;\nEND MODULE;\n'
mk no_end_module_no_semi.esql 'CREATE COMPUTE MODULE N2\nEND MODULE\n'
mk no_routine_end_no_semi.esql 'CREATE COMPUTE MODULE N3\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND\nEND MODULE;\n'
mk no_datatype_varchar.esql 'CREATE COMPUTE MODULE N4\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE a VARCHAR(50);\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_datatype_namevalue.esql 'CREATE COMPUTE MODULE N5\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE nv NAMEVALUE;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_datatype_logical.esql 'CREATE COMPUTE MODULE N6\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE l LOGICAL;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_declare_shared_in_routine.esql 'CREATE COMPUTE MODULE N7\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE a SHARED INTEGER;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_declare_scalar_namespace_clause.esql 'CREATE COMPUTE MODULE N8\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE sp CHARACTER(60) NAMESPACE '"'"'http://x'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_declare_scalar_name_clause.esql 'CREATE COMPUTE MODULE N9\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE sp CHARACTER NAME '"'"'ns'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_param_reference_to.esql 'CREATE COMPUTE MODULE NA\nCREATE PROCEDURE P(OUT r2 REFERENCE TO InputRoot)\nBEGIN\nEND;\nEND MODULE;\n'
mk no_param_decimal_precision.esql 'CREATE COMPUTE MODULE NB\nCREATE FUNCTION F(INOUT c CONSTANT DECIMAL(5, 2)) RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_handler_like.esql 'CREATE COMPUTE MODULE NC\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE CONTINUE HANDLER FOR SQLSTATE '"'"'05001'"'"', LIKE '"'"'4%'"'"'\n  SET Environment.Variable.Note = '"'"'h'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_handler_value.esql 'CREATE COMPUTE MODULE ND\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE CONTINUE HANDLER FOR VALUE 42\n  SET Environment.Variable.Note = '"'"'h'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_set_type_space.esql 'CREATE COMPUTE MODULE NE\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  SET OutputRoot.Data.Item TYPE '"'"'NameValue'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_set_namespace_space.esql 'CREATE COMPUTE MODULE NF\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  SET OutputRoot.Data.Item NAMESPACE '"'"'http://x'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_literal_bit.esql 'CREATE COMPUTE MODULE NG\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE s CHARACTER;\n  SET s = BIT '"'"'0101'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_literal_char.esql 'CREATE COMPUTE MODULE NH\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE s CHARACTER;\n  SET s = CHAR '"'"'a'"'"';\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_insert_where.esql 'CREATE COMPUTE MODULE NI\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  INSERT INTO Database.tab (a) VALUES (1) WHERE 1 = 1;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_select_aggregate_sum.esql 'CREATE COMPUTE MODULE NJ\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE n INTEGER;\n  SET n = SELECT ITEM SUM(I.a) FROM InputRoot.XMLNS.Data.Item[] AS I;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_log_event_full.esql 'CREATE COMPUTE MODULE NK\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  LOG EVENT FULL VALUES (1);\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_log_ut_full_only.esql 'CREATE COMPUTE MODULE NL\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  LOG USER TRACE FULL;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_log_ut_full_values.esql 'CREATE COMPUTE MODULE NM\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  LOG USER TRACE FULL VALUES ('"'"'m'"'"');\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_broker_schema_leading_dot.esql 'BROKER SCHEMA .mft.S1\nCREATE COMPUTE MODULE NN\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_bare_create_module.esql 'CREATE MODULE NB1\nEND MODULE;\n'
mk no_interval_plural.esql 'CREATE COMPUTE MODULE NB2\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  DECLARE iv INTERVAL DAY;\n  SET iv = INTERVAL '"'"'5'"'"' DAYS;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
mk no_move_rooted_source.esql 'CREATE COMPUTE MODULE NO\nCREATE FUNCTION Main() RETURNS BOOLEAN\nBEGIN\n  MOVE OutputRoot.XMLNS.a.b TO OutputRoot.XMLNS.c;\n  RETURN TRUE;\nEND;\nEND MODULE;\n'
echo "generated $(ls "$OUT" | wc -l) probes"
