#!/usr/bin/env bash
# commit_gate.sh — Verifikations-Gate gemäß agent.md §2.2 (adaptiert aus dem
# freien game-agnostischen Referenz-Workflow). Wird VOR jedem Commit ausgeführt.
#
# Nutzung:
#   bash addons/mcp/testing/commit_gate.sh              # prüft Arbeitskopie
#   bash addons/mcp/testing/commit_gate.sh --cached     # prüft nur Staged
#
# Exit 0 = Gate bestanden. Exit 1 = Commit unterbinden.

set -u

MODE="worktree"
if [ "${1:-}" = "--cached" ]; then
  MODE="cached"
fi

FAILED=0

fail() {
  echo "  [GATE FAIL] $1"
  FAILED=1
}

pass() {
  echo "  [ok] $1"
}

echo "════════════════════════════════════════════════════"
echo " MCP Commit-Gate (agent.md §2.2) — Modus: $MODE"
echo "════════════════════════════════════════════════════"

# Dateiliste: gestaged oder Arbeitskopie
if [ "$MODE" = "cached" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)
else
  FILES=$(git status --porcelain 2>/dev/null | awk '{print $2}')
fi

if [ -z "$FILES" ]; then
  echo "  [ok] keine Änderungen — nichts zu prüfen"
  exit 0
fi

# ─── Regel 1: Kopplungs-Check (ENTKOPPLUNG.md §6) ──────────────────
echo "→ Regel 1: Kopplungs-Check (Spiel-Pfade/Labels im Addon-Kern)"
# Kopplungs-Muster: konkrete Host-Projekt-Namen/Pfade sind hier bewusst NICHT
# fest eincodiert — das Gate prüft strukturelle Kopplung (Spiel-Root-Pfade,
# die dem Addon nicht gehören). Projektspezifische Namen ergänzt jedes
# Host-Projekt selbst in seiner Kopie dieses Gates.
COUPLING_PATTERN='res://scenes/main_menu/main_menu|res://scripts/preflight\.gd|res://scripts/tools/audio_analyzer'
COUPLING_HITS=""
for f in $FILES; do
  case "$f" in
    # L4-Archiv (agent.md §4): Session-Kontext ist dort erlaubt.
    *MCP_ANOMALIES.md|*BESTANDSAUFNAHME.md|*PLAYTEST_REPORT.md|*UX_REPORT.md|*CONTEXT_AUTONOMY_AUDIT.md)
      continue ;;
    # Der Vertrag selbst dokumentiert die Migration ALT (hartkodiert) → NEU
    # (ENTKOPPLUNG.md §7): Die Alt-Pfade sind dort Beispiele, kein Code.
    *ENTKOPPLUNG.md)
      continue ;;
    # Dieses Gate hier: Das Muster selbst ist Struktur, keine Kopplung.
    *commit_gate.sh)
      continue ;;
    mcp/client/playthroughs/*)
      continue ;;
  esac
  HITS=$(grep -nE "$COUPLING_PATTERN" "$f" 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    COUPLING_HITS="$COUPLING_HITS$f:
$HITS
"
  fi
done
if [ -n "$COUPLING_HITS" ]; then
  fail "Kopplung im Addon-Kern gefunden (ENTKOPPLUNG.md §6, agent.md §2.5):"
  echo "$COUPLING_HITS"
else
  pass "keine Kopplung im Addon-Kern"
fi

# ─── Regel 2: Staging-Disziplin (agent.md §2.3) ────────────────────
echo "→ Regel 2: Staging-Disziplin"
if git status --porcelain 2>/dev/null | grep -qE '^\?\? '; then
  UNTRACKED=$(git status --porcelain | grep -E '^\?\? ' | awk '{print $2}')
  echo "  [HINWEIS] ungetrackte Dateien vorhanden — bewusst stagen oder im Commit-Body unter 'Notizen:' vermerken:"
  echo "$UNTRACKED" | sed 's/^/      /'
else
  pass "keine ungetrackten Dateien"
fi

# ─── Regel 3: Pflicht-Doku-Betroffenheit (agent.md §2.5) ───────────
echo "→ Regel 3: Pflicht-Doku-Betroffenheit"
DOC_HITS=$(echo "$FILES" | grep -E 'agent\.md$|ENTKOPPLUNG\.md$|MCP_INDEX\.md$|PERSISTENCE\.md$' || true)
if [ -n "$DOC_HITS" ]; then
  echo "  [HINWEIS] Pflicht-Doku geändert — Cross-References prüfen (agent.md §2.2 Punkt 3):"
  echo "$DOC_HITS" | sed 's/^/      /'
else
  pass "Pflicht-Doku nicht betroffen"
fi

# ─── Ergebnis ──────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════"
if [ "$FAILED" -ne 0 ]; then
  echo " GATE: FEHLGESCHLAGEN — Commit wird unterbunden."
  exit 1
fi
echo " GATE: BESTANDEN."
exit 0
