#!/bin/bash
# Push Dashboard to GitHub Pages
# Usage: bash ~/show-dashboard-test/push-dashboard.sh
#
# Architecture (since 2026-06-10): index.html is a lightweight live app —
# it fetches current data from Airtable through the Cloudflare Worker proxy
# on every page load. Pushing is only needed when the PAGE itself changes,
# never for data updates.

REPO_DIR="$HOME/show-dashboard-test"
FILE="$REPO_DIR/index.html"

cd "$REPO_DIR" || exit 1

# ══════════════════════════════════════════════════════
# PRE-PUSH VALIDATION — live-app architecture
# ══════════════════════════════════════════════════════
echo "🔍 Validating dashboard before push..."

ERRORS=0

# File exists and is a sane size for the live app (roughly 15–80 KB)
BYTES=$(wc -c < "$FILE" 2>/dev/null)
if [ -z "$BYTES" ] || [ "$BYTES" -lt 15000 ]; then
    echo "❌ FAIL: index.html is too small ($BYTES bytes). Core code may be missing."
    ERRORS=$((ERRORS + 1))
fi
if [ -n "$BYTES" ] && [ "$BYTES" -gt 300000 ]; then
    echo "❌ FAIL: index.html is huge ($BYTES bytes) — looks like baked-in data crept back in."
    ERRORS=$((ERRORS + 1))
fi

# Critical pieces of the live app
for TOKEN in "fuse-dashboard-proxy" "async function loadAll" "function renderDetail" "function renderList" "function buildModel" "async function toggleMail" "function tryPin" "pinGate" "dash_pin" "viwT3CcaSHtTVAZBi"; do
    if ! grep -q "$TOKEN" "$FILE"; then
        echo "❌ FAIL: Missing critical piece: $TOKEN"
        ERRORS=$((ERRORS + 1))
    fi
done

# No hardcoded stale data (old static dashboard had baked 'Updated:' stamps)
if grep -q 'Updated: [A-Z][a-z]* [0-9]' "$FILE"; then
    echo "❌ FAIL: Found a hardcoded 'Updated:' date — data must come live from Airtable."
    ERRORS=$((ERRORS + 1))
fi

# JS syntax check if node is available
if command -v node >/dev/null 2>&1; then
    awk '/<script>/{f=1;next} /<\/script>/{f=0} f' "$FILE" > /tmp/dash-check.js
    if ! node --check /tmp/dash-check.js 2>/tmp/dash-check-err; then
        echo "❌ FAIL: JavaScript syntax error:"
        cat /tmp/dash-check-err
        ERRORS=$((ERRORS + 1))
    fi
fi

if [ "$ERRORS" -gt 0 ]; then
    echo ""
    echo "🚫 BLOCKED: $ERRORS validation error(s). Fix the issues before pushing."
    exit 1
fi

echo "✅ All validations passed."
echo ""

# Set git identity if not set
git config user.email "iqlarode@gmail.com" 2>/dev/null
git config user.name "Iq" 2>/dev/null

# Stage page + worker + this script (worker.js is versioned here; deployed via Cloudflare)
git add index.html worker.js push-dashboard.sh wrangler.toml 2>/dev/null
if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "Update dashboard $(date '+%Y-%m-%d %H:%M')"
fi

# Push any unpushed commits
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/main 2>/dev/null)
if [ "$LOCAL" = "$REMOTE" ]; then
    echo "✅ Dashboard is already up to date. Nothing to push."
    exit 0
fi

echo "🚀 Pushing update to GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Dashboard updated! Live at:"
    echo "   https://iqlarode-wq.github.io/show-dashboard/"
    echo ""
    echo "   (May take ~30 seconds to refresh)"
else
    echo "❌ Push failed. Check your internet connection or GitHub auth."
fi
