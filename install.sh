#!/usr/bin/env bash
#
# Garelier installer
#
# Symlinks each skills/garelier-* directory into ~/.claude/skills/
# so that Claude Code can discover them across all projects.
#
# Windows users: ensure Developer Mode is enabled
# (Settings -> Update & Security -> For Developers -> Developer Mode)
# before running this script under MSYS2 or Git Bash.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/skills"
SKILLS_DIR="${HOME}/.claude/skills"

if [ ! -d "${SOURCE_DIR}" ]; then
    echo "Error: skills directory not found at ${SOURCE_DIR}" >&2
    exit 1
fi

mkdir -p "${SKILLS_DIR}"

installed=0
skipped=0

shopt -s nullglob
for skill_path in "${SOURCE_DIR}"/garelier-*; do
    [ -d "${skill_path}" ] || continue

    skill_name="$(basename "${skill_path}")"
    target="${SKILLS_DIR}/${skill_name}"

    if [ -L "${target}" ]; then
        # Replace existing symlink
        rm "${target}"
    elif [ -e "${target}" ]; then
        # Back up existing real file/directory
        backup="${target}.bak.$(date +%Y%m%d-%H%M%S)"
        echo "  ! ${target} exists. Backing up to ${backup}"
        mv "${target}" "${backup}"
    fi

    ln -s "${skill_path}" "${target}"
    echo "  + ${skill_name}"
    installed=$((installed + 1))
done
shopt -u nullglob

echo ""
if [ "${installed}" -eq 0 ]; then
    echo "No skills found under ${SOURCE_DIR} (yet)."
    echo "Add directories named 'garelier-*' under skills/ and re-run."
else
    echo "Installed ${installed} skill(s) into ${SKILLS_DIR}"
    echo ""
    echo "Dev tip: to use the 'garelier <subcommand>' command (e.g. 'garelier doctor')"
    echo "         in this symlink install, add this repo's bin/ to your PATH:"
    echo "           export PATH=\"${SCRIPT_DIR}/bin:\$PATH\""
    echo "         (plugin installs add bin/ to PATH automatically.)"
    echo ""
    echo "See docs/getting_started.md to bootstrap a project."
fi
