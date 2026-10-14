#!/bin/sh
cd "$(dirname "$0")" || exit 1
npm run db:migrate || { echo "Migration failed, not starting the app."; read -r _; exit 1; }
npm run dev -- --open
