#!/usr/bin/env bash
# Deploy ConvoSync backend to AWS via ~/.ssh/config host "convosync-api".
#
# Usage:
#   ./deploy.sh              # git push + remote pull/build/restart
#   ./deploy.sh --no-push    # only deploy what's already on GitHub
#   ./deploy.sh --branch main
#
set -euo pipefail

SSH_HOST="${SSH_HOST:-convosync-aws}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/convosync-api}"
BRANCH="${BRANCH:-main}"
PM2_APP="${PM2_APP:-convosync-api}"
PUSH=true

usage() {
  cat <<'EOF'
Deploy ConvoSync backend to AWS (SSH host: convosync-api).

Options:
  --no-push       Skip local git push (deploy existing remote branch)
  --branch NAME   Git branch to deploy (default: main)
  -h, --help      Show this help

Environment overrides:
  SSH_HOST      SSH config host (default: convosync-api)
  REMOTE_DIR    App path on server (default: /home/ubuntu/convosync-api)
  BRANCH        Git branch (default: main)
  PM2_APP       PM2 process name (default: convosync-api)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-push) PUSH=false; shift ;;
    --branch)
      BRANCH="${2:?--branch requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Note: `ssh -G` succeeds even for unknown Host aliases; this only catches ssh misconfig.
if ! ssh -G "$SSH_HOST" >/dev/null 2>&1; then
  echo "SSH host '$SSH_HOST' not usable (check ~/.ssh/config)" >&2
  exit 1
fi

echo "==> ConvoSync backend deploy"
echo "    SSH host : $SSH_HOST"
echo "    Branch   : $BRANCH"
echo "    Remote   : $REMOTE_DIR"

if $PUSH; then
  echo "==> Pushing origin/$BRANCH..."
  git push origin "$BRANCH"
else
  echo "==> Skipping git push (--no-push)"
fi

echo "==> Deploying on server..."
ssh "$SSH_HOST" bash -s -- "$REMOTE_DIR" "$BRANCH" "$PM2_APP" <<'REMOTE'
set -euo pipefail

REMOTE_DIR="$1"
BRANCH="$2"
PM2_APP="$3"

cd "$REMOTE_DIR"

echo "    Fetching latest code..."
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "    Installing dependencies..."
npm ci

echo "    Building (prisma generate + tsc)..."
npm run build:prod

echo "    Applying migrations..."
npx prisma migrate deploy --schema=src/prisma/schema.prisma

echo "    Restarting PM2..."
if [[ -f ecosystem.config.js ]]; then
  pm2 reload ecosystem.config.js --env production
else
  # First boot needs `pm2 start npm --name convosync-api -- start` (or ecosystem);
  # restart only works if the process already exists.
  pm2 restart "$PM2_APP"
fi

echo "    Done. PM2 status:"
pm2 status "$PM2_APP"
REMOTE

echo "==> Deploy complete."
