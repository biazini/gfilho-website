# gfilho.net

Source of [gfilho.net](https://gfilho.net/), the personal site of Guilherme Filho: platform and infrastructure engineer working on hybrid cloud and automation.

A static, single-page site: plain HTML, CSS and a small JavaScript file. No framework, no build step, no third-party requests at runtime.

## Structure

```
site/                    what gets published (the web root)
  index.html             the page
  404.html               not-found page
  assets/css/main.css    all styles (design tokens at the top)
  assets/js/main.js      footer year, section-nav highlight, "Latest project" pulse
  assets/fonts/          self-hosted Newsreader and Hanken Grotesk (latin subset) + licences
  assets/img/            profile photo, app icons
  favicon.svg / .ico, apple-touch-icon.png, og-image.png, site.webmanifest, robots.txt, sitemap.xml
deploy/
  deploy.sh              publish site/ to staging or production (with automatic backup)
  install-nginx.sh       install the nginx configuration (rolls back if `nginx -t` fails)
  nginx/                 server blocks, security headers, cache rules, redirects
tools/
  build-images.ps1       regenerate og-image.png, icons and favicon.ico with headless Chrome
  og-image.html, icon.html
```

## Hosting

The site is served by nginx inside WSL (Ubuntu) and published through a Cloudflare Tunnel:

```
visitor ── HTTPS ──> Cloudflare ── tunnel ──> nginx 127.0.0.1:8088 ──> /var/www/html
```

nginx listens on loopback only. It redirects `http://` and `www.` to `https://gfilho.net/` (using the `CF-Visitor` header set by Cloudflare) and sends the security headers (CSP, nosniff, frame-ancestors, referrer and permissions policies).

A second server on `127.0.0.1:8089` serves `/var/www/gfilho-staging` for previews.

## Working on the site

Edit the files under `site/` and preview them before publishing. From WSL, as root:

```bash
# one-time (or after changing deploy/nginx/*)
bash deploy/install-nginx.sh

# preview at http://localhost:8089/
bash deploy/deploy.sh staging

# publish to https://gfilho.net/
bash deploy/deploy.sh production
```

Each deploy first copies the current target to `/var/backups/gfilho/<timestamp>-<target>/`. To roll back:

```bash
rsync -a --delete /var/backups/gfilho/<snapshot>/ /var/www/html/
```

Conventions:

- **Articles and projects:** the newest goes first. The featured project keeps `id="latest-project"`, which the "Latest project" link points to.
- **Cache busting:** CSS and JS are cached for an hour. After changing them, bump `?v=` in the `<link>` and `<script>` tags of `index.html` (and in `404.html` for the CSS).
- **Sitemap:** update `<lastmod>` in `site/sitemap.xml` when the content changes.
- **CSP:** the policy only allows same-origin resources. Inline `<script>` and `style=""` attributes are blocked; keep styles in `main.css` and code in `main.js`.

## Images

`og-image.png` (1200×630 social preview), the PNG icons and `favicon.ico` are generated from `tools/*.html`. On Windows with Google Chrome installed:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-images.ps1
```

## Licences

- Fonts: [Newsreader](https://github.com/productiontype/Newsreader) and [Hanken Grotesk](https://github.com/marcologous/hanken-grotesk), both under the SIL Open Font License 1.1. The licence texts are in `site/assets/fonts/`.
- Icons are based on [Lucide](https://lucide.dev/) (ISC licence, see `site/assets/LICENSE-lucide.txt`).
- Text, photo and logo: © Guilherme Filho.
