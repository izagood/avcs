#!/usr/bin/env bash
#
# AVCS installer — puts an `avcs` launcher on your PATH so you can run the CLI
# from anywhere as `avcs <command>`.
#
# Two ways to run it:
#
#   # 1) One-liner (clones the repo for you, then installs):
#   curl -fsSL https://raw.githubusercontent.com/izagood/avcs/main/install.sh | bash
#
#   # 2) From inside a checkout you already have:
#   ./install.sh
#
# AVCS runs its TypeScript sources directly via Node's type-stripping
# (`--experimental-strip-types`), so there is no build step: the launcher is a
# thin wrapper that execs `node ... src/cli.ts`. Re-running this script (e.g.
# after `git pull`) is safe and just refreshes the launcher.
#
# Usage:
#   ./install.sh [--bin-dir <dir>] [--name <cmd>] [--dir <dir>] [--ref <ref>]
#
# Options:
#   --bin-dir <dir>   where to write the launcher (default: $AVCS_BIN_DIR,
#                     else ~/.local/bin)
#   --name <cmd>      launcher name (default: avcs)
#   --dir <dir>       where to clone the repo in one-liner mode
#                     (default: $AVCS_HOME, else ~/.local/share/avcs)
#   --ref <ref>       branch/tag/commit to clone in one-liner mode (default: main)
#   -h, --help        show this help
#
# Environment:
#   AVCS_BIN_DIR      default launcher directory
#   AVCS_HOME         default clone directory (one-liner mode)
#   AVCS_REPO_URL     git URL to clone (default: https://github.com/izagood/avcs.git)
#   AVCS_REF          default ref to clone (one-liner mode)
#   AVCS_NODE         node binary to use if `node` isn't on PATH
#
set -euo pipefail

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=6

err() { echo "avcs install: $*" >&2; exit 1; }

# --- resolve the repo root (directory this script lives in, if any) -----------
# When piped via `curl … | bash` there is no script file on disk, so REPO_ROOT
# stays empty and we fall into clone mode below.
REPO_ROOT=""
SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SOURCE" ] && [ -f "$SOURCE" ]; then
  while [ -h "$SOURCE" ]; do
    DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
  done
  REPO_ROOT="$(cd -P "$(dirname "$SOURCE")" && pwd)"
fi

# --- parse args ---------------------------------------------------------------
BIN_DIR="${AVCS_BIN_DIR:-$HOME/.local/bin}"
CMD_NAME="avcs"
CLONE_DIR="${AVCS_HOME:-$HOME/.local/share/avcs}"
REPO_URL="${AVCS_REPO_URL:-https://github.com/izagood/avcs.git}"
REF="${AVCS_REF:-main}"
while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="${2:?--bin-dir needs a value}"; shift 2 ;;
    --name)    CMD_NAME="${2:?--name needs a value}"; shift 2 ;;
    --dir)     CLONE_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --ref)     REF="${2:?--ref needs a value}"; shift 2 ;;
    -h|--help)
      if [ -n "$SOURCE" ] && [ -f "$SOURCE" ]; then
        sed -n '2,35p' "$SOURCE" | sed 's/^# \{0,1\}//'
      else
        echo "usage: ./install.sh [--bin-dir <dir>] [--name <cmd>] [--dir <dir>] [--ref <ref>]"
      fi
      exit 0 ;;
    *) echo "avcs install: unknown option '$1'" >&2; exit 2 ;;
  esac
done

# --- clone mode: no checkout around this script, so fetch one -----------------
if [ -z "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/src/cli.ts" ]; then
  command -v git >/dev/null 2>&1 || err "git is required to bootstrap from $REPO_URL — install git, or run ./install.sh from a checkout."
  if [ -d "$CLONE_DIR/.git" ]; then
    echo "updating: $CLONE_DIR ($REF)"
    git -C "$CLONE_DIR" fetch --depth 1 origin "$REF" >/dev/null 2>&1 || err "git fetch of '$REF' failed in $CLONE_DIR."
    git -C "$CLONE_DIR" checkout -q FETCH_HEAD || err "git checkout of '$REF' failed in $CLONE_DIR."
  else
    [ -e "$CLONE_DIR" ] && [ ! -d "$CLONE_DIR" ] && err "$CLONE_DIR exists and is not a directory."
    echo "cloning:  $REPO_URL -> $CLONE_DIR ($REF)"
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$CLONE_DIR" >/dev/null 2>&1 \
      || git clone --depth 1 "$REPO_URL" "$CLONE_DIR" >/dev/null 2>&1 \
      || err "git clone of $REPO_URL failed."
  fi
  REPO_ROOT="$CLONE_DIR"
fi

# --- locate a usable node -----------------------------------------------------
NODE_BIN=""
if [ -n "${AVCS_NODE:-}" ] && [ -x "$AVCS_NODE" ]; then
  NODE_BIN="$AVCS_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  err "Node.js (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}) was not found on PATH. Install it (https://nodejs.org) or set AVCS_NODE=/path/to/node."
fi

# --- check the version (type-stripping needs >= 22.6) -------------------------
NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ "${NODE_MAJOR:-0}" -lt "$MIN_NODE_MAJOR" ] ||
   { [ "${NODE_MAJOR:-0}" -eq "$MIN_NODE_MAJOR" ] && [ "${NODE_MINOR:-0}" -lt "$MIN_NODE_MINOR" ]; }; then
  err "Node ${NODE_VERSION} is too old; AVCS needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for --experimental-strip-types."
fi

CLI_ENTRY="$REPO_ROOT/src/cli.ts"
[ -f "$CLI_ENTRY" ] || err "could not find the CLI entry at $CLI_ENTRY — the checkout at $REPO_ROOT looks incomplete."

# --- write the launcher -------------------------------------------------------
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/$CMD_NAME"

cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# AVCS launcher — generated by install.sh. Do not edit by hand; re-run install.sh.
set -euo pipefail
AVCS_HOME="$REPO_ROOT"
# Prefer a node on PATH so version managers (nvm/fnm/volta) keep working;
# fall back to the node this was installed with.
NODE_BIN="\${AVCS_NODE:-}"
if [ -z "\$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="node"
  elif [ -x "$NODE_BIN" ]; then
    NODE_BIN="$NODE_BIN"
  else
    echo "avcs: Node.js (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}) not found on PATH. Set AVCS_NODE=/path/to/node." >&2
    exit 1
  fi
fi
exec "\$NODE_BIN" --disable-warning=ExperimentalWarning --experimental-strip-types "\$AVCS_HOME/src/cli.ts" "\$@"
EOF
chmod +x "$LAUNCHER"

echo "installed: $LAUNCHER -> $CLI_ENTRY"
echo "node:      $NODE_BIN (v$NODE_VERSION)"

# --- PATH hint ----------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "ready:     run \`$CMD_NAME help\` to get started." ;;
  *)
    echo
    echo "NOTE: $BIN_DIR is not on your PATH. Add it, e.g.:"
    echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
    ;;
esac
