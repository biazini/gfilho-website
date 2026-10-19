#!/usr/bin/env bash
# Publish site/ to the local nginx (run inside WSL as root).
#
#   sudo deploy/deploy.sh staging      -> /var/www/gfilho-staging  (http://localhost:8089)
#   sudo deploy/deploy.sh production   -> /var/www/html            (https://gfilho.net via the tunnel)
#
# The current target is copied to /var/backups/gfilho/<timestamp>-<target>/ first, so a deploy
# can be undone with:  rsync -a --delete /var/backups/gfilho/<snapshot>/ /var/www/html/
set -euo pipefail

target="${1:-}"
case "$target" in
  staging)    dest=/var/www/gfilho-staging; port=8089 ;;
  production) dest=/var/www/html;           port=8088 ;;
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
src="$(cd "$(dirname "$0")/../site" && pwd)"
[ -f "$src/index.html" ] || { echo "site/index.html not found in $src" >&2; exit 1; }

stamp="$(date +%Y%m%d-%H%M%S)"
backup="/var/backups/gfilho/${stamp}-${target}"
mkdir -p "$dest" "$backup"
rsync -a "$dest/" "$backup/"
chmod -R go-rwx /var/backups/gfilho
echo "backup:  $backup"

# --delete-excluded: the target is an exact copy of site/, so stray dotfiles and backups are removed too
# (/.well-known/ is the one dot-directory that is published: it holds security.txt)
rsync -a --delete --delete-excluded --checksum --chmod=D755,F644 \
  --include='/.well-known/' --include='/.well-known/**' \
  --exclude='.*' --exclude='*.bak' --exclude='*~' \
  "$src/" "$dest/"
chown -R root:root "$dest"
echo "synced:  $src -> $dest"

code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/")"
missing="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/no-such-page")"
echo "check:   / -> $code, /no-such-page -> $missing"
[ "$code" = 200 ] && [ "$missing" = 404 ] || { echo "post-deploy check failed; restore with: rsync -a --delete $backup/ $dest/" >&2; exit 1; }
