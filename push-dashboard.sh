#!/bin/bash
# Deploy Dashboard
# Usage: bash ~/show-dashboard-test/push-dashboard.sh
#
# Architecture (since 2026-06-10 PM): the dashboard is SERVED BY CLOUDFLARE
# at https://fuse-dashboard-proxy.iqlarodework.workers.dev/ (worker + static
# asset). Data is fetched live from Airtable through the same worker, so this
# script is only needed when the PAGE or WORKER code changes — never for data.
# GitHub remains as a code backup only (its Pages deploys are unreliable).

REPO_DIR="$HOME/show-dashboard-test"
FILE="$REPO_DIR/index.html"

cd "$REPO_DIR" || exit 1

# ══════════════════════════════════════════════════════
# PRE-DEPLOY VALIDATION
# ══════════════════════════════════════════════════════
echo "🔍 Validating dashboard before deploy..."

ERRORS=0

BYTES=$(wc -c < "$FILE" 2>/dev/null)
if [ -z "$BYTES" ] || [ "$BYTES" -lt 15000 ]; then
    echo "❌ FAIL: index.html is too small ($BYTES bytes). Core code may be missing."
    ERRORS=$((ERRORS + 1))
fi
if [ -n "$BYTES" ] && [ "$BYTES" -gt 300000 ]; then
    echo "❌ FAIL: index.html is huge ($BYTES bytes) — looks like baked-in data crept back in."
    ERRORS=$((ERRORS + 1))
fi

for TOKEN in "fuse-dashboard-proxy" "async function loadAll" "function renderDetail" "function renderList" "function buildModel" "async function toggleMail" "function tryPin" "pinGate" "dash_pin" "viwT3CcaSHtTVAZBi"; do
    if ! grep -q "$TOKEN" "$FILE"; then
        echo "❌ FAIL: Missing critical piece: $TOKEN"
        ERRORS=$((ERRORS + 1))
    fi
done

if grep -q 'Updated: [A-Z][a-z]* [0-9]' "$FILE"; then
    echo "❌ FAIL: Found a hardcoded 'Updated:' date — data must come live from Airtable."
    ERRORS=$((ERRORS + 1))
fi

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
    echo "🚫 BLOCKED: $ERRORS validation error(s). Fix the issues before deploying."
    exit 1
fi

echo "✅ All validations passed."
echo ""

# ══════════════════════════════════════════════════════
# DEPLOY TO CLOUDFLARE (the real publish)
# ══════════════════════════════════════════════════════
mkdir -p "$REPO_DIR/public"
cp "$FILE" "$REPO_DIR/public/index.html"

echo "☁️  Deploying to Cloudflare..."
npx wrangler deploy
if [ $? -ne 0 ]; then
    echo "❌ Cloudflare deploy failed. If it asked you to log in, run: npx wrangler login"
    exit 1
fi

echo ""
echo "✅ Dashboard live at:"
echo "   https://fuse-dashboard-proxy.iqlarodework.workers.dev/"
echo ""

# ══════════════════════════════════════════════════════
# GITHUB BACKUP (best-effort; failures here don't matter)
# ══════════════════════════════════════════════════════
git config user.email "iqlarode@gmail.com" 2>/dev/null
git config user.name "Iq" 2>/dev/null

git add index.html public/index.html worker.js push-dashboard.sh wrangler.toml SETUP.md 2>/dev/null
if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "Update dashboard $(date '+%Y-%m-%d %H:%M')"
fi
git push origin main 2>/dev/null && echo "📦 GitHub backup pushed." || echo "⚠️  GitHub backup push failed (non-critical — Cloudflare is live)."
