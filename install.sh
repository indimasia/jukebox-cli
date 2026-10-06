#!/usr/bin/env bash
# Jukebox installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/indimasia/jukebox-cli/main/install.sh | bash
set -euo pipefail

REPO="${JUKEBOX_REPO:-indimasia/jukebox-cli}"
BRANCH="${JUKEBOX_BRANCH:-main}"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/jukebox"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# 1. System packages, only the missing ones: ffmpeg, qrencode, node (+ yt-dlp on macOS)
missing=()
has ffmpeg || missing+=(ffmpeg)
has qrencode || missing+=(qrencode)
case "$(uname -s)" in
  Darwin)
    has node || missing+=(node)
    has yt-dlp || missing+=(yt-dlp)
    if [ ${#missing[@]} -gt 0 ]; then
      has brew || die "Homebrew is required: https://brew.sh"
      say "Installing ${missing[*]} with Homebrew"
      brew install "${missing[@]}"
    fi
    ;;
  Linux)
    has node || missing+=(nodejs)
    has curl || missing+=(curl)
    if [ ${#missing[@]} -gt 0 ]; then
      say "Installing ${missing[*]}"
      if has apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y "${missing[@]}"
      elif has dnf; then $SUDO dnf install -y "${missing[@]}" || die "ffmpeg on Fedora needs RPM Fusion: https://rpmfusion.org"
      elif has pacman; then $SUDO pacman -Sy --needed --noconfirm "${missing[@]}"
      else die "unsupported distro: install ${missing[*]} yourself, then re-run"
      fi
    fi
    # Distro yt-dlp is usually too old for YouTube; use the official binary.
    mkdir -p "$BIN_DIR"
    say "Installing latest yt-dlp to $BIN_DIR"
    curl -fL --progress-bar https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$BIN_DIR/yt-dlp"
    chmod +x "$BIN_DIR/yt-dlp"
    ;;
  *) die "unsupported OS: $(uname -s) (macOS and Linux only)" ;;
esac

has node || die "node not found after install"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node 18+ required, found $(node -v). Install a newer one: https://nodejs.org"

# 2. The app itself: use the local copy if run from a clone, else download it.
mkdir -p "$APP_DIR" "$BIN_DIR"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/jukebox.mjs" ]; then
  cp "$SRC_DIR/jukebox.mjs" "$APP_DIR/jukebox.mjs"
else
  say "Downloading jukebox.mjs"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$BRANCH/jukebox.mjs" -o "$APP_DIR/jukebox.mjs"
fi
chmod +x "$APP_DIR/jukebox.mjs"
ln -sf "$APP_DIR/jukebox.mjs" "$BIN_DIR/jukebox"

say "Installed: $BIN_DIR/jukebox"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\nAdd this to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:\n  export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac
printf '\nStart a room:  jukebox host\nJoin one:      jukebox join <host:port> <CODE> [name]\n'
