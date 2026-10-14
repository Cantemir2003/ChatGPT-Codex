#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24 LTS from nodejs.org, then run First-time Setup.command.'
  read -r -p 'Press Return to close. '
  exit 1
fi
node scripts/launcher.mjs start
result=$?
if [ "$result" -ne 0 ]; then read -r -p 'Press Return to close. '; fi
exit "$result"
