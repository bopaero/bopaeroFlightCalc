#!/bin/bash
# TripCalc lead gate end-to-end check: bash scripts/lead-gate/check.sh
set -e
cd "$(dirname "$0")/../.."
OUT=${OUT:-$(mktemp -d)}
python3 scripts/lead-gate/lead_mock.py 8766 . & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1
OUT=$OUT node scripts/lead-gate/check.mjs
