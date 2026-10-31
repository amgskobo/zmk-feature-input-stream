#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

if [[ -n ${INPUT_STREAM_NATIVE_ARTIFACTS:-} && ( -e "$INPUT_STREAM_NATIVE_ARTIFACTS" || -L "$INPUT_STREAM_NATIVE_ARTIFACTS" ) ]]; then
    echo "Use a fresh INPUT_STREAM_NATIVE_ARTIFACTS directory; existing evidence is preserved" >&2
    exit 2
fi
root="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
export ZEPHYR_BASE="${ZEPHYR_BASE:-$(west list zephyr -f '{abspath}')}"
zmk_root="${ZMK_ROOT:-$(west list zmk -f '{abspath}')}"
nanopb_root="${NANOPB_ROOT:-$(west list nanopb -f '{abspath}')}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT HUP INT TERM
out="${INPUT_STREAM_NATIVE_ARTIFACTS:-$work/results}"
if [ -e "$out/status.tsv" ]; then echo 'Use fresh INPUT_STREAM_NATIVE_ARTIFACTS' >&2; exit 2; fi
mkdir -p "$work/generated"
cp -a "$nanopb_root/generator" "$work/generator"
python3 "$work/generator/nanopb_generator.py" -I "$root/proto" -D "$work/generated" \
    "$root/proto/zmk/input_stream/input_stream.proto"
python3 "$work/generator/nanopb_generator.py" -I "$root/tests/sender" -D "$work/generated" \
    "$root/tests/sender/envelope.proto"
args=()
if [ -n "${INPUT_STREAM_SOURCE:-}" ]; then args+=(-DINPUT_STREAM_SOURCE="$INPUT_STREAM_SOURCE"); fi
if ! west build -p=always -b native_sim/native/64 -s "$root/tests/sender" -d "$work/build" -- \
    -DZMK_ROOT="$zmk_root" -DNANOPB_ROOT="$nanopb_root" -DGENERATED_ROOT="$work/generated" \
    -DWEST=OFF -DZEPHYR_MODULES= -DZephyr_DIR="$ZEPHYR_BASE/share/zephyr-package/cmake" "${args[@]}" > "$work/build.log" 2>&1; then
    cat "$work/build.log" >&2; exit 2
fi
mkdir -p "$out"
cp "$work/build.log" "$work/build/CMakeCache.txt" "$out/"
cp "$work/build/zephyr/.config" "$out/config"
cp "$work/build/zephyr/zephyr.elf" "$work/build/zephyr/zephyr.exe" "$out/"
failed=0
for scenario in control stop restart full fair race missing blocking locked lock-race lock-dispatch endpoint encoding lookup; do
    for run in 1 2 3; do
        status=0
        INPUT_STREAM_CASE="$scenario" timeout 15 "$work/build/zephyr/zephyr.exe" > "$out/$scenario-$run.log" 2>&1 || status=$?
        cat "$out/$scenario-$run.log"
        printf '%s %s %s\n' "$scenario" "$run" "$status" >> "$out/status.tsv"
        [ "$status" = 0 ] || failed=1
    done
done
echo 'Completed input-stream sender scenarios=14 repeats=3'
exit "$failed"
