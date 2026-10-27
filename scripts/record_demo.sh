#!/usr/bin/env bash
# Record (or dry-run) the esql-lsp feature demo for docs/demo.cast.
#
#   scripts/record_demo.sh            # drive the tour, verify every step, no cast
#   scripts/record_demo.sh --record   # same tour, captured with asciinema
#
# The tour runs inside tmux driving real Neovim against the real server, so
# every keystroke round-trips through the LSP. Each step asserts the pane
# before moving on: a green verify run means the recorded frames contain the
# same content at the same moments. It runs identically in grammar mode and
# with ESQL_LSP_NO_GRAMMAR=1 in the environment — no assertion depends on the
# parse tree (that is the point: the features shown are sold in both modes).
#
# Pacing is tuned to be watched, not just executed: literal text types one
# character at a time, and every pause multiplies by DEMO_SCALE (default 1.6).
# The tour shows: diagnostics, a live fix, hover, completion, references,
# document symbols, workspace symbols across files, SHARED resolution across
# files, a quick fix from the code-action picker, a cross-file go-to-
# definition and a cross-file SHARED rename, then closes the module.
#
# Env:  ESQL_LSP_BIN (server entry, default bin/esql-lsp.js via node)
#       DEMO_CAST    (output .cast path)   DEMO_SCALE (pause multiplier)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${ESQL_LSP_BIN:-$REPO/bin/esql-lsp.js}"
OUT="${DEMO_CAST:-$REPO/docs/demo.cast}"
DEMO_DIR="$REPO/scripts/demo"
W="${DEMO_W:-110}" H="${DEMO_H:-30}"
SESS="esqldemo-$$"
SCALE="${DEMO_SCALE:-1.6}"
RECORD=0
[ "${1:-}" = "--record" ] && RECORD=1

[ -r "$BIN" ] || { echo "server entry not found: $BIN (run npm run build)"; exit 1; }
[ -r "$REPO/dist/src/server.js" ] || { echo "dist/src/server.js missing (run npm run build)"; exit 1; }
command -v node >/dev/null || { echo "node is required"; exit 1; }
command -v tmux >/dev/null || { echo "tmux is required"; exit 1; }
if [ "$RECORD" = 1 ]; then
  command -v asciinema >/dev/null || { echo "asciinema is required for --record"; exit 1; }
  mkdir -p "$(dirname "$OUT")"
fi

WORK="$(mktemp -d)"
cp "$DEMO_DIR/demo.esql" "$DEMO_DIR/ReceiverShared.esql" "$WORK/"
cleanup() { tmux kill-session -t "$SESS" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

P() { sleep "$(awk -v b="$1" -v s="$SCALE" 'BEGIN{printf "%.2f", b*s}')"; }
S() { tmux send-keys -t "$SESS" "$@"; }      # named keys
# Literal text arrives one character at a time so the gif reads like typing.
TYPEDELAY="$(awk -v s="$SCALE" 'BEGIN{printf "%.3f", 0.045*s}')"
L() { # literal text, typewriter-paced
  local s="$1" i
  for (( i = 0; i < ${#s}; i++ )); do
    tmux send-keys -t "$SESS" -l -- "${s:i:1}"
    sleep "$TYPEDELAY"
  done
}
# tmux 3.6 send-keys silently drops a ';' that ends a -l argument (and a
# bare ';' argument) — bit me as vanished statement terminators. A trailing
# ';' goes as its raw hex byte instead; mid-string semicolons are unaffected.
T() { L "${1%;}"; S -H 3b; }                # literal line ending in ';'
wait_pane() { # wait_pane blurb pattern [pattern...]
  local blurb="$1"; shift
  local end=$((SECONDS + 25)) cap miss=""
  while :; do
    cap="$(tmux capture-pane -p -t "$SESS")"
    miss=""
    for pat in "$@"; do grep -qF -- "$pat" <<<"$cap" || miss="$miss [$pat]"; done
    [ -z "$miss" ] && return 0
    [ "$SECONDS" -lt "$end" ] || { echo "FAIL ($blurb): pane never showed:$miss"
      echo "----- pane -----"; echo "$cap"; echo "----------------"; exit 1; }
    sleep 0.2
  done
}
wait_pane_not() { # wait_pane_not blurb pattern [pattern...]  (each must be gone)
  local blurb="$1"; shift
  local end=$((SECONDS + 25)) cap still=""
  while :; do
    cap="$(tmux capture-pane -p -t "$SESS")"
    still=""
    for pat in "$@"; do grep -qF -- "$pat" <<<"$cap" && still="$still [$pat]"; done
    [ -z "$still" ] && return 0
    [ "$SECONDS" -lt "$end" ] || { echo "FAIL ($blurb): pane still shows:$still"
      echo "----- pane -----"; echo "$cap"; echo "----------------"; exit 1; }
    sleep 0.2
  done
}

# line 3's virtual text is now mode-independent: E-7 makes the grammar path
# drop its module-definition phrasing on the line the structure check owns,
# so both paths show the better-worded missing-END MODULE message.
MODE_PAT="is missing its closing"

tmux -f "$DEMO_DIR/tmux.demo.conf" new-session -d -s "$SESS" -x "$W" -y "$H"

REC_PID=""
if [ "$RECORD" = 1 ]; then
  # `script` gives asciinema a tty whose size we fix, so the cast header and
  # the tmux window agree and nothing reflows mid-recording.
  script -qec "stty rows $H cols $W; TERM=xterm-256color asciinema rec --overwrite --idle-time-limit 2.5 \
    -c 'tmux attach -d -t $SESS' '$OUT'" /dev/null &
  REC_PID=$!
  sleep 1
fi

# tmux sessions live in the shared tmux server, which never sees a fresh
# caller environment — pass the mode switch inline (this is also what the
# cast records: grammar mode unless the caller exports the switch).
NOG=""
if [ "${ESQL_LSP_NO_GRAMMAR:-}" = "1" ]; then NOG="ESQL_LSP_NO_GRAMMAR=1 "; fi
S "cd '$WORK' && ESQL_LSP_BIN='$BIN' ${NOG}exec nvim -u '$DEMO_DIR/init.lua' -i NONE demo.esql" Enter

echo "[1] open file; server attaches and publishes diagnostics"
wait_pane "diagnostics published" "$MODE_PAT" "is assigned here" "Building OutputRoot.JSON.Data"
P 3.2

echo "[2] fix the undeclared variable live: add the DECLARE, warning clears"
L "/OrderCount"; S Enter; P 0.6
S O
T "DECLARE OrderCount INTEGER 0;"; S Escape
wait_pane_not "warning cleared" "OrderCount' is assigned here"
P 1.6
L ":w"; S Enter; P 0.8

echo "[3] hover the message tree root: docs come from the ESQL reference"
L "/OutputRoot"; S Enter; P 0.6
S K
wait_pane "hover float" "Complete outgoing message tree"
P 2.6
S C-w o; P 0.7

echo "[4] completion: the declared ReplyText, requested for the word in SET"
# /RETURN TRUE, not /RETURN: a bare /RETURN matches the RETURNS of the
# CREATE FUNCTION line first whenever the search starts above it.
L "/RETURN TRUE"; S Enter; P 0.6
S O
# ReplyTe, not ReplyT: ReplyTo (a message-tree name) matches the shorter
# prefix too; ReplyTe is uniquely ReplyText's. <C-x><C-o> asks the server,
# C-y accepts what the menu offers.
L "SET OutputRoot.JSON.Data.Msg = ReplyTe"; P 0.7
S C-x C-o; P 1.6
S C-y
S -H 3b; S Escape
wait_pane "completion accepted" "Msg = ReplyText;"
P 1.0
L ":w"; S Enter; P 0.8

echo "[5] references of TotalCount in a quickfix window"
L "/TotalCount"; S Enter; P 0.6
S space g r
wait_pane "quickfix window" "Quickfix" "TotalCount"
P 2.2
L ":cclose"; S Enter; P 0.7

echo "[6] document symbols: outline of modules, routines and declarations"
S space d s
wait_pane "location list" "Location List"
P 2.2
L ":lclose"; S Enter; P 0.7

echo "[7] workspace symbol: CopyMessageHeaders lives in the SIBLING file (I-13)"
S space w s
wait_pane "workspace symbol" "CopyMessageHeaders"
P 1.6
S Enter
wait_pane "jumped into sibling file" "SharedDecls"
P 2.2
# close the list window: :cclose is focus-agnostic (q is NOT mapped in
# quickfix windows; and no :bd here — deleting buffers from the wrong
# focus collapses the window layout)
L ":cclose"; S Enter; P 0.6
wait_pane_not "quickfix closed" "Quickfix List"
L ":b#"; S Enter; P 0.8
wait_pane "back to the flow" "CREATE COMPUTE MODULE DemoFlow"

echo "[8] a CALL, a SHARED use and a typo: only the typo gets flagged"
L "/RETURN TRUE"; S Enter; P 0.6
S O
T "CALL CopyMessageHeaders();"; S Escape; P 0.5
S O
T "SET FailureCount = FailureCount + 1;"; S Escape
wait_pane "typed SHARED use" "FailureCount + 1;"
# dwell: the warning would have to appear here if cross-file resolution
# were missing — the re-check lands well within this pause on any sane box
P 3.0
tmux capture-pane -p -t "$SESS" | grep -qF "FailureCount' is assigned here" \
  && { echo "FAIL: sibling SHARED did not resolve — warning appeared"; exit 1; }
tmux capture-pane -p -t "$SESS" | grep -qF "FailureCount' is read here" \
  && { echo "FAIL: sibling SHARED did not resolve the read half — warning appeared"; exit 1; }
S O
T "SET FailureConceal = 1;"; S Escape
wait_pane "typo still flagged" "FailureConceal' is assigned here"
P 2.0

echo "[9] quick fix: the picker's Declare inserts the skeleton, warning clears"
# The cursor must sit on the flagged name for the codeAction range. The
# picker is nvim's numbered list and Enter on an EMPTY number cancels, so
# the choice is typed as '1' + Enter, not a bare Enter.
L "/FailureConceal"; S Enter; P 0.6
S space c a
wait_pane "code action picker" "Declare 'FailureConceal' as CHARACTER"
P 1.8
L "1"; S Enter
wait_pane "declare inserted" "DECLARE FailureConceal CHARACTER;"
wait_pane_not "typo warning cleared" "FailureConceal' is assigned here"
P 1.4
L ":w"; S Enter; P 0.8

echo "[10] go to definition: the CALL target lives in the sibling file"
L "/CopyMessageHeaders"; S Enter; P 0.6
S space g d
wait_pane "jumped to the definition" "CREATE PROCEDURE CopyMessageHeaders()"
P 2.4

echo "[11] rename the SHARED declaration: the sweep rewrites both files"
# From the declaration (rename targets are declarations and routine names;
# a use in another file greys out on purpose). The inline prompt prefills
# the current name — Ctrl-U clears it before the new name is typed.
L "/FailureCount"; S Enter; P 0.6
S space r n
wait_pane "rename prompt" "New Name:"
P 1.2
S C-u
P 1.0
L "FailureTotal"
P 1.2
S Enter
# nvim 0.11 renders the cross-file honesty note (the change-annotation
# label) as its apply-confirmation prompt — the message the server wanted
# the user to read, sitting in the pane. Answer it (empty cancels the
# prompt, never the already-applied edits) and save both buffers.
wait_pane "cross-file rename note" "renamed 'FailureCount' in 2 workspace files"
P 2.6
S Enter; P 0.6
L ":wa"; S Enter; P 0.8
L ":b#"; S Enter; P 0.9
wait_pane "the flow reads the new name" "SET FailureTotal = FailureTotal + 1;"
P 2.0

echo "[12] close the module: type END MODULE, structure errors clear"
S G; P 0.4
S o
T "END MODULE;"; S Escape
wait_pane_not "module closed" "is missing its closing"
P 2.0

echo "[13] save and quit"
L ":w"; S Enter; P 0.6
L ":q"; S Enter; P 1.2

if [ "$RECORD" = 1 ]; then
  wait "$REC_PID" || { echo "FAIL: asciinema rec exited non-zero"; exit 1; }
  head -c 200 "$OUT" | head -1 | grep -q "\"width\": *$W" \
    || { echo "WARN: cast header does not match ${W}x${H}; check before publishing"; }
  echo
  echo "cast written: $OUT"
  echo "review it:    asciinema play $OUT"
  echo "make the gif: agg $OUT docs/demo.gif   then commit both"
else
  echo
  echo "verify tour completed (add --record to capture $OUT)"
fi
