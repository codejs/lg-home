#!/usr/bin/env bash
# Archive the source tree into archive/<name>-<version>-<timestamp>.zip,
# leaving out build output, test output, local data, VCS metadata and secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
stamp=$(date +%Y%m%d-%H%M%S)
outdir=archive
out="$outdir/$name-$version-$stamp.zip"

mkdir -p "$outdir"

zip -rq "$out" . -x \
  '.git/*' \
  'node_modules/*' \
  'dist/*' 'build/*' 'out/*' 'output/*' \
  'coverage/*' '.nyc_output/*' 'test-results/*' 'playwright-report/*' \
  'data/*' \
  "$outdir/*" \
  '*.DS_Store' \
  '.idea/*' '*.iml' '*.ipr' '*.iws' \
  '.env' '.env.*.local' '.env.local' \
  '*.log'

echo "Created $out ($(du -h "$out" | cut -f1))"
