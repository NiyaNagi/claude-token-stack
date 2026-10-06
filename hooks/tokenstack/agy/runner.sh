#!/usr/bin/env bash
# tokenstack Antigravity runner — executes ONE delegation job inside WSL/Linux.
# Usage: runner.sh <job-dir>   (job-dir holds job.env + prompt.txt; written by agy-run.js)
# Writes: pid, events.jsonl (agy stream-json), stderr.log, exit
# Git snapshots are taken on the Windows side (Windows git owns the checkout; WSL git can disagree on CRLF/filemode).
set -u
JOB="$1"
cd "$JOB" || { echo "runner: no job dir $JOB" >&2; exit 2; }
# shellcheck disable=SC1091
. ./job.env   # MODEL, TIMEOUT_S, YOLO, WORKDIR, ADD_DIRS (newline-separated)
echo $$ > pid
AGY="${AGY_BIN:-$HOME/.local/bin/agy}"
[ -x "$AGY" ] || AGY="$(command -v agy || true)"
if [ -z "$AGY" ]; then echo "agy not installed in this Linux environment" > stderr.log; echo 13 > exit; exit 13; fi
if [ -n "${WORKDIR:-}" ] && [ ! -d "$WORKDIR" ]; then
  echo "workdir not reachable from Linux: $WORKDIR (for a mapped network drive run once: sudo mkdir -p /mnt/z && sudo mount -t drvfs Z: /mnt/z)" > stderr.log
  echo 16 > exit; exit 16
fi

args=(-p "$(cat prompt.txt)" --model "$MODEL" --output-format stream-json --print-timeout "${TIMEOUT_S}s")
[ "${YOLO:-1}" = "1" ] && args+=(--dangerously-skip-permissions)
if [ -n "${WORKDIR:-}" ]; then cd "$WORKDIR" && args+=(--add-dir "$WORKDIR"); fi
while IFS= read -r d; do [ -n "$d" ] && [ -d "$d" ] && args+=(--add-dir "$d"); done <<< "${ADD_DIRS:-}"

# Wall-clock guard on top of agy's own --print-timeout (agy -p can hang without a console on some hosts).
timeout --kill-after=15 "$(( TIMEOUT_S + 60 ))" "$AGY" "${args[@]}" < /dev/null > "$JOB/events.jsonl" 2> "$JOB/stderr.log"
rc=$?
echo "$rc" > "$JOB/exit"
exit "$rc"
