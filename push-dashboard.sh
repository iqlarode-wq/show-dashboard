#!/bin/bash
# Push Dashboard to GitHub Pages
# Usage: bash ~/show-dashboard-test/push-dashboard.sh
#
# Expects index.html to already be updated in the repo folder
# (Cowork scheduled task writes directly here)

REPO_DIR="$HOME/show-dashboard-test"
FILE="$REPO_DIR/index.html"

cd "$REPO_DIR" || exit 1

# ══════════════════════════════════════════════════════
# PRE-PUSH VALIDATION — ensures critical features exist
# ══════════════════════════════════════════════════════
echo "🔍 Validating dashboard before push..."

ERRORS=0

# Check file exists and has reasonable size (>3500 lines = has all features)
LINES=$(wc -l < "$FILE" 2>/dev/null)
if [ -z "$LINES" ] || [ "$LINES" -lt 3500 ]; then
    echo "❌ FAIL: index.html is too short ($LINES lines, expected 3500+). A feature may have been removed."
    ERRORS=$((ERRORS + 1))
fi

# Check Files & Links CSS exists
if ! grep -q "files-area" "$FILE"; then
    echo "❌ FAIL: Files & Links CSS is missing (.files-area)"
    ERRORS=$((ERRORS + 1))
fi

# Check Files & Links JS functions exist
for FUNC in "function fetchFiles" "function renderDropboxLinks" "function renderFilesList" "function onFilesToggle"; do
    if ! grep -q "$FUNC" "$FILE"; then
        echo "❌ FAIL: Missing JS function: $FUNC"
        ERRORS=$((ERRORS + 1))
    fi
done

# Check Files & Links HTML accordions exist
ACCORDION_COUNT=$(grep -c "files-accordion-" "$FILE")
if [ "$ACCORDION_COUNT" -lt 8 ]; then
    echo "❌ FAIL: Only $ACCORDION_COUNT Files accordion blocks found (expected 8)"
    ERRORS=$((ERRORS + 1))
fi

# Check Comments section exists
if ! grep -q "function fetchComments" "$FILE"; then
    echo "❌ FAIL: Comments JS is missing (function fetchComments)"
    ERRORS=$((ERRORS + 1))
fi

# Check navigateToDetail has the toggleCard guard
if ! grep -q "toggleCard" "$FILE"; then
    echo "❌ FAIL: navigateToDetail guard (toggleCard fallback) is missing"
    ERRORS=$((ERRORS + 1))
fi

# Check show cards exist
CARD_COUNT=$(grep -c 'data-event-id=' "$FILE")
if [ "$CARD_COUNT" -lt 8 ]; then
    echo "❌ FAIL: Only $CARD_COUNT show cards found (expected 8)"
    ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
    echo ""
    echo "🚫 BLOCKED: $ERRORS validation error(s). Fix the issues before pushing."
    echo "   DO NOT remove features to fix bugs — fix the bugs themselves."
    exit 1
fi

echo "✅ All validations passed."
echo ""

# Set git identity if not set
git config user.email "iqlarode@gmail.com" 2>/dev/null
git config user.name "Iq" 2>/dev/null

# Stage and commit if there are changes
git add index.html
if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "Update dashboard $(date '+%Y-%m-%d %H:%M')"
fi

# Push any unpushed commits (including empty commits from Cowork)
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
