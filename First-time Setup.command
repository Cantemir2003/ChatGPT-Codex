#!/bin/bash
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd -- "$(dirname -- "$0")"
trap 'result=$?; if [ "$result" -ne 0 ]; then echo; echo "Setup did not finish. Read the message above and the README, then try again."; fi; read -r -p "Press Return to close. "; exit "$result"' EXIT
if [ "$(uname -s)" != 'Darwin' ]; then
  echo 'This setup launcher requires macOS. See docs/DEVELOPMENT.md for development commands.'
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Install Node.js 24 LTS using the macOS installer at https://nodejs.org/en/download, then try again.'
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error("Please install Node.js 24 LTS. See README.md."); process.exit(1); }'
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo 'FFmpeg is missing. Follow the one-time Homebrew and FFmpeg steps in README.md, then try again.'
  exit 1
fi
if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo 'Apple Command Line Tools are missing. Open Terminal, type xcode-select --install, press Return, and finish the installer. Then try setup again.'
  exit 1
fi
echo 'Preparing Lecture Transcriber. The first setup needs an internet connection.'
mkdir -p bin
xcrun swiftc scripts/keychain.swift -o bin/keychain-helper -framework Security
chmod 700 bin/keychain-helper
npm ci --no-audit --no-fund
npm run build
chmod +x ./*.command
echo
echo 'Setup complete. Double-click Start Lecture Transcriber.command to open the app.'
echo 'Enter your API key only in the local app. Do not type it into this Terminal window.'
