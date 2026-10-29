#!/bin/sh
# Hosts a chat from this computer: makes sure a relay runs here and has a public
# trycloudflare link that answers, starting either when it doesn't, and prints the
# link. Both run in the background on their own, so they outlive Claude Code.
#
#   sh host.sh        start what's missing, print the public link
#   sh host.sh stop   stop the relay and the link this script started
#
# CHAT_HOME (default ~/.claude-team-chat) keeps their pids, logs and the link.

set -u
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" # the desktop app's PATH may lack Homebrew
DIR="${CHAT_HOME:-$HOME/.claude-team-chat}"
PORT="${PORT:-47800}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LOCAL="http://127.0.0.1:$PORT"
mkdir -p "$DIR"

answers() { curl -fsS --max-time "${2:-3}" "$1/health" >/dev/null 2>&1; }

# Runs a command in a session of its own, so it keeps running after whoever started it.
detach() {
  log="$1"
  shift
  nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$@" >>"$log" 2>&1 </dev/null &
  echo $!
}

stop_pid() {
  [ -f "$DIR/$1.pid" ] && kill "$(cat "$DIR/$1.pid")" 2>/dev/null
  rm -f "$DIR/$1.pid"
}

if [ "${1:-}" = stop ]; then
  stop_pid tunnel
  stop_pid relay
  rm -f "$DIR/link"
  echo stopped
  exit 0
fi

# 1. A relay on this computer: reuse one that answers, else start it.
if ! answers "$LOCAL" 2; then
  command -v node >/dev/null || { echo "Hosting needs Node.js (nodejs.org)." >&2; exit 3; }
  detach "$DIR/relay.log" env HOST=127.0.0.1 PORT="$PORT" TRUST_PROXY=1 node "$HERE/relay.mjs" >"$DIR/relay.pid"
  i=0
  until answers "$LOCAL" 1; do
    i=$((i + 1))
    [ "$i" -gt 40 ] && { echo "The relay didn't start; see $DIR/relay.log" >&2; exit 3; }
    sleep 0.25
  done
fi

# 2. A public link to it: reuse the last one while it answers, else open a new one.
if [ -f "$DIR/link" ] && answers "$(cat "$DIR/link")" 5; then
  cat "$DIR/link"
  exit 0
fi
command -v cloudflared >/dev/null || { echo "Hosting needs cloudflared: brew install cloudflared" >&2; exit 4; }
stop_pid tunnel
: >"$DIR/tunnel.log"
detach "$DIR/tunnel.log" cloudflared tunnel --no-autoupdate --url "$LOCAL" >"$DIR/tunnel.pid"
LINK=""
i=0
while [ -z "$LINK" ]; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "cloudflared gave no link; see $DIR/tunnel.log" >&2; exit 5; }
  sleep 0.5
  LINK="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$DIR/tunnel.log" | head -n 1)"
done
# Wait until the tunnel is connected and Cloudflare's DNS has the new name, asking
# 1.1.1.1 directly: asking this computer's resolver too early makes it remember
# "no such name" for a while, and then nothing here can reach the link.
NAME="$(echo "$LINK" | sed -E 's#https://([^/]+).*#\1#')"
i=0
until grep -q 'Registered tunnel connection' "$DIR/tunnel.log" &&
  { ! command -v dig >/dev/null || dig +short @1.1.1.1 "$NAME" A 2>/dev/null | grep -qE '^[0-9.]+$'; }; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "The new link $LINK isn't up yet; try again in a minute." >&2; exit 5; }
  sleep 0.5
done
i=0
until answers "$LINK" 3; do
  i=$((i + 1))
  [ "$i" -gt 30 ] && { echo "The new link $LINK doesn't answer yet; try again in a minute." >&2; exit 5; }
  sleep 1
done
echo "$LINK" >"$DIR/link"
echo "$LINK"
