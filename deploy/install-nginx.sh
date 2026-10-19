#!/usr/bin/env bash
# Install the nginx configuration for gfilho.net (run inside WSL as root).
# Keeps a copy of the previous configuration and rolls back automatically if `nginx -t` fails.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
here="$(cd "$(dirname "$0")/nginx" && pwd)"

stamp="$(date +%Y%m%d-%H%M%S)"
backup="/var/backups/gfilho/${stamp}-nginx"
mkdir -p "$backup"
cp -a /etc/nginx/sites-available "$backup/"
cp -a /etc/nginx/sites-enabled "$backup/"
cp -a /etc/nginx/snippets "$backup/"
chmod -R go-rwx /var/backups/gfilho
echo "backup:  $backup"

rollback() {
  echo "nginx -t failed, restoring $backup" >&2
  rm -rf /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/snippets
  cp -a "$backup/sites-available" "$backup/sites-enabled" "$backup/snippets" /etc/nginx/
  nginx -t && systemctl reload nginx
  exit 1
}

install -m 644 "$here/gfilho-common.conf" /etc/nginx/snippets/gfilho-common.conf
install -m 644 "$here/gfilho.conf" /etc/nginx/sites-available/gfilho.conf
ln -sfn /etc/nginx/sites-available/gfilho.conf /etc/nginx/sites-enabled/gfilho.conf
# the stock "default" site listened on the same port; it stays in sites-available, only disabled
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/gfilho-staging

nginx -t || rollback
systemctl reload nginx
sleep 1
# A reload cannot move an existing wildcard socket (0.0.0.0:8088) to loopback-only: nginx logs
# "bind() failed" and keeps the old configuration. Restart in that case (about a second of downtime).
if ss -ltn | grep -qE '(0\.0\.0\.0|\[::\]|\*):808[89]\b' || ! ss -ltn | grep -q '127\.0\.0\.1:8088\b'; then
  echo "listen addresses changed, restarting nginx"
  systemctl restart nginx
fi
echo "nginx running with the new configuration"
ss -ltn | grep -E ':(8088|8089)\b' || true
