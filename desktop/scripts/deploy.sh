#!/usr/bin/env bash
#
# One-command booth redeploy: build → package → ship → verify (→ optionally
# relaunch). Idempotent and safe to re-run; aborts on any checksum mismatch.
#
#   ./scripts/deploy.sh                 # build, package, ship, verify
#   ./scripts/deploy.sh --restart       # …and relaunch on the booth TV (DISPLAY=:0)
#   ./scripts/deploy.sh --ship-only     # skip build+package, ship the existing AppImage
#   ./scripts/deploy.sh --no-build      # skip pnpm build, still repackage + ship
#   ./scripts/deploy.sh --booth user@host[:dir]
#
# Booth defaults to the Linux Mint kiosk; override with --booth or BOOTH=.
# Passwordless SSH (key already installed) is assumed.

set -euo pipefail

BOOTH="${BOOTH:-axenstax@192.168.191.32}"
DEST="${DEST:-.}"          # remote dir (relative to login home, or absolute)
RESTART=0
DO_BUILD=1
DO_PACKAGE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --restart)   RESTART=1 ;;
    --no-build)  DO_BUILD=0 ;;
    --ship-only) DO_BUILD=0; DO_PACKAGE=0 ;;
    --booth)     BOOTH="$2"; shift ;;
    -h|--help)
      sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "deploy: unknown arg '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# Allow --booth user@host:dir to carry a remote directory.
case "$BOOTH" in
  *:*) DEST="${BOOTH#*:}"; BOOTH="${BOOTH%%:*}" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)

step() { printf '\n▶ %s\n' "$1"; }

if [ "$DO_BUILD" = 1 ]; then
  step "Building game (pnpm build)…"
  ( cd "$REPO_DIR" && pnpm build )
fi

if [ "$DO_PACKAGE" = 1 ]; then
  step "Packaging AppImage…"
  ( cd "$DESKTOP_DIR" && npm run dist )
fi

APP="$(ls -t "$DESKTOP_DIR"/out/*.AppImage 2>/dev/null | head -1 || true)"
if [ -z "$APP" ]; then
  echo "deploy: no AppImage in $DESKTOP_DIR/out — run without --ship-only first." >&2
  exit 1
fi
BASENAME="$(basename "$APP")"
LOCAL_SHA="$(shasum -a 256 "$APP" | awk '{print $1}')"
SIZE="$(du -h "$APP" | awk '{print $1}')"
step "Artifact: $BASENAME ($SIZE)  sha256=${LOCAL_SHA:0:12}…"

REMOTE_PATH="$DEST/$BASENAME"
TMP_PATH="$DEST/$BASENAME.part"

# Upload to a temp name first: if the old AppImage is still running its file is
# busy (ETXTBSY) and a direct overwrite fails. A rename over the target swaps it
# atomically — the running process keeps its old inode until it exits.
step "Transferring to $BOOTH:$REMOTE_PATH …"
scp -o BatchMode=yes "$APP" "$BOOTH:$TMP_PATH"

step "Installing + verifying on booth…"
REMOTE_SHA="$("${SSH[@]}" "$BOOTH" "chmod +x '$TMP_PATH' && mv -f '$TMP_PATH' '$REMOTE_PATH' && sha256sum '$REMOTE_PATH'" | awk '{print $1}')"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "✗ CHECKSUM MISMATCH — transfer corrupt" >&2
  echo "  local:  $LOCAL_SHA" >&2
  echo "  remote: $REMOTE_SHA" >&2
  exit 1
fi
echo "✓ checksum verified on booth"

if [ "$RESTART" = 1 ]; then
  step "Relaunching on booth (DISPLAY=:0)…"
  # Two separate SSH calls on purpose: a combined kill+launch command line
  # contains the literal AppImage path, so `pkill -f` would match (and kill)
  # its own shell before the launch runs.
  # Match the MOUNTED process name (/tmp/.mount_*/pallasite-desktop), not the
  # .AppImage path — once mounted, argv no longer contains ".AppImage". The
  # '[p]' makes the pattern not match the kill command's own argv (self-safe),
  # and the launch command (…/Pallasite-…AppImage) contains no "pallasite-desktop".
  # SIGTERM first (lets Electron clean up its SingletonLock), then KILL stragglers.
  # A SIGKILL'd instance leaves SingletonLock behind, which makes the next launch
  # see "another instance" and quit instantly — so clear the locks before launch.
  "${SSH[@]}" "$BOOTH" "pkill -TERM -f '[p]allasite-desktop' 2>/dev/null; sleep 2; pkill -9 -f '[p]allasite-desktop' 2>/dev/null; rm -f \$HOME/.config/pallasite-desktop/Singleton* 2>/dev/null; true" || true
  sleep 1
  "${SSH[@]}" "$BOOTH" \
    "DISPLAY=:0 XAUTHORITY=\$HOME/.Xauthority setsid '$REMOTE_PATH' >/tmp/pallasite.log 2>&1 </dev/null & echo '  relaunched (log: /tmp/pallasite.log)'" || true

  step "Health check (game :8123, broker :8788)…"
  # Poll rather than a fixed sleep — a cold 4K Electron start after a kill can
  # take ~10-12s, longer than any single wait we'd want to hardcode.
  "${SSH[@]}" "$BOOTH" '
    for i in $(seq 1 12); do
      g=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8123/version.json 2>/dev/null);
      b=$(curl -s http://127.0.0.1:8788/healthz 2>/dev/null);
      if [ "$g" = "200" ] && echo "$b" | grep -q "\"ok\":true"; then
        echo "  game http: $g"; echo "  broker:    $b"; echo "  ✓ both healthy"; exit 0;
      fi
      sleep 2;
    done
    echo "  game http: ${g:-down}"; echo "  broker:    ${b:-DOWN}";
    echo "  ✗ still unhealthy after ~24s — tail /tmp/pallasite.log on the booth"; exit 1;
  ' || echo "  (health check reported a problem — inspect /tmp/pallasite.log on the booth)"
fi

printf '\n✓ Deployed %s → %s:%s/\n' "$BASENAME" "$BOOTH" "$DEST"
[ "$RESTART" = 1 ] || printf '  Launch on the booth: ./%s   (or re-run with --restart)\n' "$BASENAME"
