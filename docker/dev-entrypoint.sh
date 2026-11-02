#!/bin/sh
set -e

if [ ! -e /app/data/workspace/.template-version ]; then
  mkdir -p /app/data/workspace
  cp -a /workspace/backend/workspace/. /app/data/workspace/
  touch /app/data/workspace/.template-version
fi

cd /workspace/backend
npm run dev &
backend_pid=$!

cd /workspace/frontend
npm run dev -- --host 0.0.0.0 &
frontend_pid=$!

terminate() {
  kill "$backend_pid" "$frontend_pid" 2>/dev/null || true
  wait "$backend_pid" "$frontend_pid" 2>/dev/null || true
}
trap terminate INT TERM

status=0
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
  sleep 1
done
kill -0 "$backend_pid" 2>/dev/null || status=$?
kill -0 "$frontend_pid" 2>/dev/null || status=$?
terminate
exit "$status"
