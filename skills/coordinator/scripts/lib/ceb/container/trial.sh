#!/bin/sh
# Runs inside a CEB task container (lib/ceb/runner.mjs starts it):  sh /ceb/trial.sh <harness arguments...>
# It notes the commit the fixture starts from, runs the harness in /work with the arguments it was
# given, and writes what the model changed to /out/diff.patch: committed or not, new files included.
# It sets and prints no secret. Files written to /out: base, harness.out, harness.err, diff.patch, exit.
set -u
cd /work || { echo "no /work in this image" >&2; exit 90; }
git config --global --add safe.directory /work >/dev/null 2>&1
base=$(git rev-parse HEAD) || { echo "/work is not a git repository" >&2; exit 91; }
printf '%s\n' "$base" > /out/base

# The time limit is kept in here, so a run that is cut off still leaves its diff. Exit 124 means it was cut off.
limit=${CEB_TIMEOUT_SECONDS:-0}
if [ "$limit" -gt 0 ] && command -v timeout >/dev/null 2>&1; then
  timeout -s TERM -k 30 "$limit" /ceb/bin/harness "$@" < /dev/null > /out/harness.out 2> /out/harness.err
else
  /ceb/bin/harness "$@" < /dev/null > /out/harness.out 2> /out/harness.err
fi
status=$?

git add -A >/dev/null 2>&1
git diff --cached --binary "$base" -- . ':(exclude).coordinator' ':(exclude).claude' > /out/diff.patch 2>> /out/harness.err
printf '%s\n' "$status" > /out/exit
exit 0
