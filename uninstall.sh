#!/usr/bin/env bash
#
# AVCS uninstaller — removes the `avcs` launcher created by install.sh.
# This only deletes the launcher; your repo checkout and any .avcs data are
# left untouched.
#
# Usage:
#   ./uninstall.sh [--bin-dir <dir>] [--name <cmd>]
#
set -euo pipefail

BIN_DIR="${AVCS_BIN_DIR:-$HOME/.local/bin}"
CMD_NAME="avcs"
while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="${2:?--bin-dir needs a value}"; shift 2 ;;
    --name)    CMD_NAME="${2:?--name needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "avcs uninstall: unknown option '$1'" >&2; exit 2 ;;
  esac
done

LAUNCHER="$BIN_DIR/$CMD_NAME"
if [ -e "$LAUNCHER" ]; then
  rm -f "$LAUNCHER"
  echo "removed: $LAUNCHER"
else
  echo "nothing to remove: $LAUNCHER not found"
fi
