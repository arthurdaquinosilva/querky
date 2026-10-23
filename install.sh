#!/bin/sh
# Installs querky straight from GitHub — no npm registry package involved:
#
#   curl -fsSL https://raw.githubusercontent.com/arthurdaquinosilva/querky/main/install.sh | sh
#
# Environment overrides:
#   QUERKY_VERSION   branch or tag to install (default: main), e.g. QUERKY_VERSION=v0.5.0
#   QUERKY_HOME      where the source lives   (default: ~/.local/lib/querky)
#   QUERKY_BIN_DIR   where the command goes   (default: ~/.local/bin)
#
# Pass --uninstall to remove it:  curl -fsSL .../install.sh | sh -s -- --uninstall
#
# querky is built from source with pnpm (the one on PATH, else through corepack or npx). The
# launcher uses `#!/usr/bin/env node`, so it runs on whichever Node is on PATH (22 or newer).

set -eu

REPO="arthurdaquinosilva/querky"
VERSION="${QUERKY_VERSION:-main}"
HOME_DIR="${QUERKY_HOME:-$HOME/.local/lib/querky}"
BIN_DIR="${QUERKY_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE="22.0"

say() { printf '%s\n' "$*"; }
err() { printf 'querky install: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

# Succeeds when version $1 >= version $2 (major.minor only).
version_ge() {
  a_major=${1%%.*}; a_rest=${1#*.}; a_minor=${a_rest%%.*}
  b_major=${2%%.*}; b_minor=${2#*.}
  [ "$a_major" -gt "$b_major" ] || { [ "$a_major" -eq "$b_major" ] && [ "$a_minor" -ge "$b_minor" ]; }
}

uninstall() {
  rm -f "$BIN_DIR/querky"
  rm -rf "$HOME_DIR"
  say "Removed querky ($HOME_DIR and $BIN_DIR/querky)."
  say "Your settings, history and aliases (~/.config/querky) were left in place."
}

download() {
  if has curl; then curl -fsSL "$1"
  elif has wget; then wget -qO- "$1"
  else err "needs curl or wget to download querky"
  fi
}

pnpm_run() {
  if has pnpm; then pnpm "$@"
  elif has corepack; then corepack pnpm "$@"
  else npx --yes pnpm@11 "$@"
  fi
}

main() {
  if [ "${1:-}" = "--uninstall" ]; then uninstall; return; fi

  has node || err "Node.js $MIN_NODE or newer is required (https://nodejs.org or nvm)"
  has pnpm || has corepack || has npx || err "pnpm (or corepack/npx to fetch it) is required to build querky"
  has tar || err "tar is required"
  node_version=$(node -p 'process.versions.node')
  version_ge "$node_version" "$MIN_NODE" || err "Node $node_version is too old; querky needs $MIN_NODE or newer"

  case "$VERSION" in
    v[0-9]*) ref="refs/tags/$VERSION" ;;
    *) ref="refs/heads/$VERSION" ;;
  esac
  url="https://github.com/$REPO/archive/$ref.tar.gz"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading querky ($VERSION)..."
  download "$url" | tar -xz -C "$tmp" --strip-components=1 || err "could not download $url"
  [ -f "$tmp/tsup.config.ts" ] || err "the download does not look like querky ($url)"

  say "Installing dependencies and building..."
  (cd "$tmp" && pnpm_run install --frozen-lockfile --reporter=silent >/dev/null) ||
    err "pnpm could not install querky's dependencies"
  (cd "$tmp" && pnpm_run build >/dev/null) || err "querky did not build"
  (cd "$tmp" && pnpm_run prune --prod --reporter=silent >/dev/null 2>&1) || true

  # Swap the new copy in only once it is complete, so a failed update leaves the old one working.
  mkdir -p "$(dirname "$HOME_DIR")" "$BIN_DIR"
  rm -rf "$HOME_DIR.old"
  [ -d "$HOME_DIR" ] && mv "$HOME_DIR" "$HOME_DIR.old"
  mv "$tmp" "$HOME_DIR"
  rm -rf "$HOME_DIR.old"
  trap - EXIT INT TERM
  chmod +x "$HOME_DIR/dist/index.js"
  ln -sf "$HOME_DIR/dist/index.js" "$BIN_DIR/querky"

  installed=$(node -p "require('$HOME_DIR/package.json').version")
  say "Installed querky $installed to $BIN_DIR/querky"

  case ":$PATH:" in
    *":$BIN_DIR:"*)
      found=$(command -v querky)
      [ "$found" = "$BIN_DIR/querky" ] ||
        say "Note: another querky comes first on PATH ($found); remove it with 'npm uninstall -g @deaquinodev/querky'."
      ;;
    *)
      say ""
      say "$BIN_DIR is not on your PATH. Add it to your shell profile (~/.zshrc or ~/.bashrc):"
      say "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
  say "Run 'querky' to start. Re-run this installer to update."
}

main "$@"
