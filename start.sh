#!/bin/bash
# Start Fulfillment App (backend + frontend)
APP_DIR="/Users/robertfan/Claude Code/fulfillment-app"
BACKEND_DIR="$APP_DIR/backend"
FRONTEND_DIR="$APP_DIR/frontend"
UVICORN="$BACKEND_DIR/venv/bin/uvicorn"
NODE="/opt/homebrew/bin/node"

osascript <<EOF
tell application "Terminal"
    activate
    set backendWin to do script "cd '$BACKEND_DIR' && '$UVICORN' main:app --reload --port 8000"
    delay 0.3
    set custom title of front window to "Fulfillment — Backend :8000"
    set frontendWin to do script "cd '$FRONTEND_DIR' && '$NODE' node_modules/.bin/vite --port 5173"
    delay 0.3
    set custom title of front window to "Fulfillment — Frontend :5173"
end tell
delay 4
open location "http://localhost:5173"
EOF
