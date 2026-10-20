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
today="$(date +%Y-%m-%d)"

# sitemap.xml: for each listed page whose HTML differs from the target, set its <lastmod> to today
# in site/ (commit it afterwards). https://gfilho.net/cases/x/ maps to site/cases/x/index.html.
if [ -f "$src/sitemap.xml" ]; then
  for loc in $(sed -n -E 's#.*<loc>([^<]+)</loc>.*#\1#p' "$src/sitemap.xml"); do
    rel="${loc#https://gfilho.net/}"
    case "$rel" in ''|*/) rel="${rel}index.html" ;; esac
    [ -f "$src/$rel" ] || continue
    cmp -s "$src/$rel" "$dest/$rel" && continue
    # only the <lastmod> inside this page's <url> block
    if sed -n "\#<loc>${loc}</loc>#,\#</url>#p" "$src/sitemap.xml" | grep -q "<lastmod>${today}</lastmod>"; then continue; fi
    sed -i -E "\#<loc>${loc}</loc>#,\#</url># s#<lastmod>[0-9]{4}-[0-9]{2}-[0-9]{2}</lastmod>#<lastmod>${today}</lastmod>#" "$src/sitemap.xml"
    echo "sitemap: ${rel} changed, <lastmod> set to ${today} (commit site/sitemap.xml)"
  done
fi

# security.txt (RFC 9116): warn 30 days before Expires; the date itself is renewed by hand
sec="$src/.well-known/security.txt"
if [ -f "$sec" ]; then
  expires="$(sed -n 's/^Expires:[[:space:]]*//p' "$sec" | head -n1 | tr -d '\r')"
  left=$(( ( $(date -d "$expires" +%s) - $(date +%s) ) / 86400 ))
  renew="$(date -u -d "+364 days" +%Y-%m-%dT23:00:00.000Z)"
  if [ "$left" -lt 0 ]; then
    echo "WARNING: security.txt expired $(( -left )) days ago. Set 'Expires: ${renew}' in site/.well-known/security.txt and deploy again." >&2
  elif [ "$left" -le 30 ]; then
    echo "WARNING: security.txt expires in ${left} days. Set 'Expires: ${renew}' in site/.well-known/security.txt and deploy again." >&2
  fi
fi

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
