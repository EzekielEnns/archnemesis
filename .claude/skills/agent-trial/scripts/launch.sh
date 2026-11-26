#!/bin/sh
# launch.sh <trial-dir> [model] [allowed tools]: open a Claude pane beside this agent, wired only to the Archnemesis MCP in
# <trial-dir>/mcp.json, given <trial-dir>/task.txt. Prints the pane's block id and the session id.
set -eu
T=$(cd "$1" && pwd); MODEL=${2:-sonnet}; ALLOW=${3:-mcp__archnm}  # comma-separated, e.g. "mcp__archnm,Agent" for a manager that starts its own workers
[ -f "$T/task.txt" ] && [ -f "$T/mcp.json" ] || { echo "need $T/task.txt and $T/mcp.json" >&2; exit 1; }
SID=$(uuidgen | tr A-Z a-z)
echo "$SID" > "$T/session-id"; echo "$MODEL" > "$T/model"
# The prompt goes after `--`: otherwise --allowedTools swallows it as more rules. It runs in the trials
# folder (the parent), the same for every trial, so Claude Code asks to trust a folder once, not per trial.
B=$(rex split -s "$REX_SESSION" -b "$REX_BLOCK" --split=right --ratio 50 --keep-open --focus=false -c "$(dirname "$T")" -- \
  claude --model "$MODEL" --session-id "$SID" --mcp-config "$T/mcp.json" --strict-mcp-config --allowedTools "$ALLOW" -- "$(cat "$T/task.txt")")
echo "$B" > "$T/block"
echo "block $B"; echo "session $SID"
