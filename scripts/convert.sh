#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 3 ]]; then
    echo "Usage: $0 <bin_path> <src_path> <dest_path>"
    exit 1
fi

BIN="$1"
SRC="$2"
DEST="$3"

mkdir -p "$DEST"

# Convert every .epub to .txt
find "$SRC" -type f -iname '*.epub' -print0 |
while IFS= read -r -d '' epub; do
    base="$(basename "$epub")"
    out="$DEST/${base}.txt"

    echo "Converting: $base"
    "$BIN" -c -m --raw "$epub" > "$out"
done

# Copy every .opf
find "$SRC" -type f -iname '*.opf' -print0 |
while IFS= read -r -d '' opf; do
    base="$(basename "$opf")"

    echo "Copying: $base"
    cp -p "$opf" "$DEST/$base"
done
