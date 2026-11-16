#!/usr/bin/env bash
# 部署到服务器
set -euo pipefail
HOST="${XFG_HOST:-51.68.234.201}"
USER="${XFG_USER:-root}"
DIR="${XFG_DIR:-/opt/xfg-app}"

cd "$(dirname "$0")/.."
tar czf /tmp/xfg-webapp.tgz --exclude=node_modules --exclude=data webapp

scp -o StrictHostKeyChecking=no /tmp/xfg-webapp.tgz "$USER@$HOST:/tmp/"

ssh -o StrictHostKeyChecking=no "$USER@$HOST" bash -s <<REMOTE
set -e
mkdir -p $DIR
tar xzf /tmp/xfg-webapp.tgz -C $DIR --strip-components=1
cd $DIR
docker compose up -d --build
sleep 3
docker compose ps
curl -s http://127.0.0.1:3001/api/health && echo
REMOTE
