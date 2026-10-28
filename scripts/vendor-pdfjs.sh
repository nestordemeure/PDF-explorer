#!/bin/sh
# Copy pdf.js into vendor/pdfjs.
# Version 3 is the last one with classic scripts. Chrome does not load ES modules from file:// pages.
# The worker goes into a string, so that the app can start it from a blob URL.
set -eu
VERSION=3.11.174
dest="$(cd "$(dirname "$0")/.." && pwd)/vendor/pdfjs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
npm pack "pdfjs-dist@$VERSION" --silent >/dev/null
tar xzf "pdfjs-dist-$VERSION.tgz"
mkdir -p "$dest"
cp package/build/pdf.min.js "$dest/"
cp package/LICENSE "$dest/LICENSE" 2>/dev/null || true
node -e 'const fs = require("fs"); process.stdout.write("window.PDFJS_WORKER_SOURCE = " + JSON.stringify(fs.readFileSync(process.argv[1], "utf8")) + ";\n");' package/build/pdf.worker.min.js > "$dest/pdf.worker.source.js"
echo "pdf.js $VERSION copied to $dest"
