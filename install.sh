#!/usr/bin/env bash
#
# Garelier installer
#
# Symlinks each skills/garelier-* directory into the Claude Code and Codex CLI
# skill directories so both agents can discover them across all projects.
#
# Windows users: ensure Developer Mode is enabled
# (Settings -> Update & Security -> For Developers -> Developer Mode)
# before running this script under MSYS2 or Git Bash.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/skills"

usage() {
    cat <<'EOF'
Usage: install.sh [--all | --claude-only | --codex-only]

Symlinks skills/garelier-* into agent skill directories.

Default:
  --all          Install into Claude Code and Codex CLI skill roots.

Targets:
  --claude-only Install only into ${CLAUDE_HOME:-$HOME/.claude}/skills
  --codex-only  Install only into ${CODEX_HOME:-$HOME/.codex}/skills

Overrides:
  CLAUDE_HOME       Base directory for Claude Code state.
  CLAUDE_SKILLS_DIR Exact Claude Code skill directory.
  CODEX_HOME        Base directory for Codex CLI state.
  CODEX_SKILLS_DIR  Exact Codex CLI skill directory.
EOF
}

install_claude=1
install_codex=1

while [ "$#" -gt 0 ]; do
    case "$1" in
        --all)
            install_claude=1
            install_codex=1
            ;;
        --claude-only)
            install_claude=1
            install_codex=0
            ;;
        --codex-only)
            install_claude=0
            install_codex=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Error: unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
    shift
done

if [ "${install_claude}" -eq 0 ] && [ "${install_codex}" -eq 0 ]; then
    echo "Error: no install targets selected" >&2
    exit 1
fi

if [ ! -d "${SOURCE_DIR}" ]; then
    echo "Error: skills directory not found at ${SOURCE_DIR}" >&2
    exit 1
fi

normalize_path() {
    local path="$1"
    if command -v cygpath >/dev/null 2>&1 && [[ "${path}" =~ ^[A-Za-z]:[\\/] ]]; then
        cygpath -u "${path}"
    else
        printf '%s\n' "${path}"
    fi
}

is_windows_bash() {
    case "$(uname -s 2>/dev/null || true)" in
        MINGW*|MSYS*|CYGWIN*) return 0 ;;
        *) return 1 ;;
    esac
}

create_symlink() {
    local source="$1"
    local target="$2"

    if is_windows_bash; then
        if ! command -v powershell.exe >/dev/null 2>&1; then
            echo "Error: powershell.exe is required to create native symlinks on Windows" >&2
            exit 1
        fi

        local source_win target_win
        source_win="$(cygpath -w "${source}")"
        target_win="$(cygpath -w "${target}")"
        GARELIER_LINK_TARGET="${source_win}" GARELIER_LINK_PATH="${target_win}" \
            powershell.exe -NoProfile -NonInteractive -Command \
                '$ErrorActionPreference = "Stop"; New-Item -ItemType SymbolicLink -Path $env:GARELIER_LINK_PATH -Target $env:GARELIER_LINK_TARGET | Out-Null'
    else
        ln -s "${source}" "${target}"
    fi
}

if [ -n "${CLAUDE_SKILLS_DIR:-}" ]; then
    claude_skills_dir="$(normalize_path "${CLAUDE_SKILLS_DIR}")"
else
    claude_home="$(normalize_path "${CLAUDE_HOME:-${HOME}/.claude}")"
    claude_skills_dir="${claude_home}/skills"
fi

if [ -n "${CODEX_SKILLS_DIR:-}" ]; then
    codex_skills_dir="$(normalize_path "${CODEX_SKILLS_DIR}")"
else
    codex_home="$(normalize_path "${CODEX_HOME:-${HOME}/.codex}")"
    codex_skills_dir="${codex_home}/skills"
fi

install_into() {
    local label="$1"
    local skills_dir="$2"
    local installed=0
    local skill_path skill_name target backup

    mkdir -p "${skills_dir}"

    echo "${label}: ${skills_dir}"

    shopt -s nullglob
    for skill_path in "${SOURCE_DIR}"/garelier-*; do
        [ -d "${skill_path}" ] || continue

        skill_name="$(basename "${skill_path}")"
        target="${skills_dir}/${skill_name}"

        if [ -L "${target}" ]; then
            # Replace existing symlink.
            rm "${target}"
        elif [ -e "${target}" ]; then
            # Back up existing real file/directory.
            backup="${target}.bak.$(date +%Y%m%d-%H%M%S)"
            echo "  ! ${target} exists. Backing up to ${backup}"
            mv "${target}" "${backup}"
        fi

        create_symlink "${skill_path}" "${target}"
        echo "  + ${skill_name}"
        installed=$((installed + 1))
    done
    shopt -u nullglob

    if [ "${installed}" -eq 0 ]; then
        echo "  No skills found under ${SOURCE_DIR} (yet)."
    else
        echo "  Installed ${installed} skill(s)."
    fi

    last_installed="${installed}"
}

total_installed=0
last_installed=0

if [ "${install_claude}" -eq 1 ]; then
    install_into "Claude Code" "${claude_skills_dir}"
    total_installed=$((total_installed + last_installed))
fi

if [ "${install_codex}" -eq 1 ]; then
    install_into "Codex CLI" "${codex_skills_dir}"
    total_installed=$((total_installed + last_installed))
fi

echo ""
if [ "${total_installed}" -eq 0 ]; then
    echo "No skills found under ${SOURCE_DIR} (yet)."
    echo "Add directories named 'garelier-*' under skills/ and re-run."
else
    echo "Installed ${total_installed} skill link(s) across selected target(s)."
    echo ""
    echo "Dev tip: to use the 'garelier <subcommand>' command (e.g. 'garelier doctor')"
    echo "         in this symlink install, add this repo's bin/ to your PATH:"
    echo "           export PATH=\"${SCRIPT_DIR}/bin:\$PATH\""
    echo "         (plugin installs add bin/ to PATH automatically.)"
    echo ""
    echo "See docs/getting_started.md to bootstrap a project."
fi
