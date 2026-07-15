#!/bin/bash
# This file is managed by PhantomWP infrastructure. It will be overwritten on update. Do not edit it manually.
# Source of truth lives in PhantomWP infrastructure generators.

# PhantomWP screenshot helper installer. Generated from
# lib/infrastructure-files.ts. Do not edit by hand.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ ! -d node_modules ]; then
  echo "📦 Installing screenshot helper deps (puppeteer-core, @puppeteer/browsers)..."
  npm install --no-audit --no-fund --loglevel=error
fi

if [ ! -d .cache ] || [ -z "$(find .cache -name chrome-headless-shell -type f 2>/dev/null | head -n 1)" ]; then
  echo "🌐 Downloading chrome-headless-shell (~80MB, one-time)..."
  npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path "$DIR/.cache"
fi

echo "✅ Screenshot helper ready"
