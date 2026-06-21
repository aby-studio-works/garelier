#!/usr/bin/env bash
#
# jig_render.sh — render the Mode E jig tick template for a ONE-OFF manual
# dispatch (DEC-062). The autonomous loop renders the tick automatically; this
# helper gives the same one-command convenience for a manual single dispatch:
# it reads [jig] from the project's setup_config (documented defaults when the
# block is absent), substitutes the template's {{placeholders}}, writes a runnable
# workflow script, and prints {scriptPath, jig, args_schema} as one JSON line so
# the PM then runs:  Workflow({ scriptPath, args: { items: [ ... ] } })
#
# Usage:
#   jig_render.sh --project <root> --pm-id <id>
#                 [--template <jig_tick.workflow.js>] [--out <path>]
#                 [--fan-out N] [--max-rework N] [--smith-every N]
#                 [--depth-low gate] [--depth-normal gate+refute]
#
# Defaults (mode_e_jig.md): fan_out_cap=3 max_rework_rounds=2 smith_batch_every=5
# review_depth.low=gate review_depth.normal=gate+refute. CLI flag > config > default.
# Generic: the only inputs are --project/--pm-id; no project-specific assumptions.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$(dirname "$SELF_DIR")"   # skills/garelier-core
# Normalize to a mixed Windows path (C:/...) on Git Bash/MSYS so the rendered
# CORE matches the C:/-form PROJECT; a no-op (cygpath absent) on Linux/tmux.
CORE_DIR="$(cygpath -m "$CORE_DIR" 2>/dev/null || printf '%s' "$CORE_DIR")"

PROJECT="" PM="" TEMPLATE="" OUT=""
O_FANOUT="" O_REWORK="" O_SMITH="" O_LOW="" O_NORMAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)      PROJECT="${2:?}"; shift 2 ;;
    --pm-id)        PM="${2:?}"; shift 2 ;;
    --template)     TEMPLATE="${2:?}"; shift 2 ;;
    --out)          OUT="${2:?}"; shift 2 ;;
    --fan-out)      O_FANOUT="${2:?}"; shift 2 ;;
    --max-rework)   O_REWORK="${2:?}"; shift 2 ;;
    --smith-every)  O_SMITH="${2:?}"; shift 2 ;;
    --depth-low)    O_LOW="${2:?}"; shift 2 ;;
    --depth-normal) O_NORMAL="${2:?}"; shift 2 ;;
    -h|--help)      sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "jig_render: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] || { echo "jig_render: --project and --pm-id are required" >&2; exit 2; }

CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"
[ -f "$CONFIG" ] || { echo "jig_render: no setup_config at $CONFIG" >&2; exit 2; }
[ -z "$TEMPLATE" ] && TEMPLATE="$CORE_DIR/templates/jig_tick.workflow.js"
[ -f "$TEMPLATE" ] || { echo "jig_render: template not found: $TEMPLATE" >&2; exit 2; }
[ -z "$OUT" ] && OUT="$PROJECT/__garelier/$PM/runtime/jig/tick.workflow.js"

# Read a key from a TOML section (handles CRLF, inline # comments, surrounding
# quotes). Echoes the value, or the supplied default when the key/section is absent.
toml_get() {  # $1=section $2=key $3=default
  local v
  v="$(awk -v sec="[$1]" -v key="$2" '
    { sub(/\r$/, "") }
    $0 == sec { ins = 1; next }
    /^\[/     { ins = 0 }
    ins && $0 ~ "^[ \t]*" key "[ \t]*=" {
      sub(/^[^=]*=[ \t]*/, ""); sub(/[ \t]*#.*$/, "");
      gsub(/^"|"$/, ""); sub(/[ \t]+$/, ""); print; exit
    }
  ' "$CONFIG")"
  if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$3"; fi
}

FANOUT="${O_FANOUT:-$(toml_get jig fan_out_cap 3)}"
REWORK="${O_REWORK:-$(toml_get jig max_rework_rounds 2)}"
SMITH="${O_SMITH:-$(toml_get jig smith_batch_every 5)}"
LOW="${O_LOW:-$(toml_get jig.review_depth low gate)}"
NORMAL="${O_NORMAL:-$(toml_get jig.review_depth normal gate+refute)}"

# The template uses fan_out/max_rework/smith_every UNQUOTED as JS numbers.
for pair in "fan_out_cap=$FANOUT" "max_rework_rounds=$REWORK" "smith_batch_every=$SMITH"; do
  case "${pair#*=}" in
    ""|*[!0-9]*) echo "jig_render: ${pair%%=*} must be a non-negative integer (got '${pair#*=}')" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$OUT")"
sed \
  -e "s|{{project_root}}|$PROJECT|g" \
  -e "s|{{pm_id}}|$PM|g" \
  -e "s|{{garelier_core_dir}}|$CORE_DIR|g" \
  -e "s|{{jig_fan_out_cap}}|$FANOUT|g" \
  -e "s|{{jig_max_rework_rounds}}|$REWORK|g" \
  -e "s|{{jig_smith_batch_every}}|$SMITH|g" \
  -e "s|{{jig_depth_low}}|$LOW|g" \
  -e "s|{{jig_depth_normal}}|$NORMAL|g" \
  "$TEMPLATE" > "$OUT"

# Only the knob placeholders must be gone; the template legitimately keeps a few
# literal "{{" tokens in its DEC-071 placeholder-DETECTION code, which are not knobs.
if grep -q '{{jig_|{{project_root}}|{{pm_id}}|{{garelier_core_dir}}' "$OUT" 2>/dev/null \
   || grep -Eq '\{\{(jig_|project_root|pm_id|garelier_core_dir)' "$OUT"; then
  echo "jig_render: an unsubstituted knob placeholder remains in $OUT" >&2; exit 1
fi

printf '{"scriptPath":"%s","jig":{"fan_out_cap":%s,"max_rework_rounds":%s,"smith_batch_every":%s,"depth_low":"%s","depth_normal":"%s"},"args_schema":"{ items: [ { role: worker|smith|librarian|artisan, slug: kebab-slug, assignmentPath: <abs path>, criticality: low|normal|critical } ] }"}\n' \
  "$OUT" "$FANOUT" "$REWORK" "$SMITH" "$LOW" "$NORMAL"
