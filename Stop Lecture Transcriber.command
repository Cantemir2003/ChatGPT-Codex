#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is missing. Open the app in your browser and use its Stop app control.'
  read -r -p 'Press Return to close. '
  exit 1
fi
node scripts/launcher.mjs stop
result=$?
if [ "$result" -ne 0 ]; then read -r -p 'Press Return to close. '; fi
exit "$result"
