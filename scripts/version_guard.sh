#!/bin/bash
# TripCalc version guard — PreToolUse hook for Claude Code.
#
# TripCalc carries its version in TWO places that must agree:
#   index.html  <span id="appVersion">vYYYY-MM-DD.N</span>
#   index.html  var APP_VERSION = 'vYYYY-MM-DD.N';
# Updating only one is the standing failure mode. This blocks a commit/push
# when they disagree, or when index.html changed without a version bump.
#
# Reads the Claude Code hook payload on stdin; exit 2 blocks the tool call and
# feeds stderr back to Claude.

REPO="/Users/raymondchase/bopaeroFlightCalc"
payload=$(cat)

cmd=$(printf '%s' "$payload" | python3 -c \
  'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)

# Only guard commit/push.
case "$cmd" in
  *"git commit"*|*"git push"*) ;;
  *) exit 0 ;;
esac

cd "$REPO" 2>/dev/null || exit 0

# Only care if index.html is actually part of this change.
if git diff --quiet HEAD -- index.html 2>/dev/null && \
   git diff --cached --quiet -- index.html 2>/dev/null; then
  exit 0
fi

span=$(grep -o 'id="appVersion">v[0-9.-]*<' index.html | head -1 | sed 's/.*>v\(.*\)</\1/')
js=$(grep -o "APP_VERSION = 'v[0-9.-]*'" index.html | head -1 | sed "s/.*'v\(.*\)'/\1/")

if [ -z "$span" ] || [ -z "$js" ]; then
  echo "VERSION GUARD: could not read both version spots in index.html (span='$span' js='$js'). Check lines ~1060 and ~1332." >&2
  exit 2
fi

if [ "$span" != "$js" ]; then
  cat >&2 <<MSG
VERSION GUARD: the two version spots in index.html disagree.
  <span id="appVersion">  ->  v$span
  var APP_VERSION         ->  v$js
Both must match. Update the one you missed, then retry.
MSG
  exit 2
fi

# index.html changed, versions agree — but was the version actually bumped?
# Compare against the version committed in HEAD, not against tags: the repo has
# two tag conventions (plain v* stopped in Apr 2026, stable-v* since), so tags
# are not a reliable "current version" source. HEAD always is.
head_ver=$(git show HEAD:index.html 2>/dev/null \
  | grep -o "APP_VERSION = 'v[0-9.-]*'" | head -1 | sed "s/.*'v\\(.*\\)'/\\1/")

if [ -n "$head_ver" ] && [ "$span" = "$head_ver" ]; then
  cat >&2 <<MSG
VERSION GUARD: index.html has changes but the version is still v$span,
the same as the last commit. Bump it in BOTH spots first:
  index.html  <span id="appVersion">   (~line 1060)
  index.html  var APP_VERSION           (~line 1332)
MSG
  exit 2
fi

exit 0
