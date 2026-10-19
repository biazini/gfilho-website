# gfilho.net

Source of [gfilho.net](https://gfilho.net/), the personal site of Guilherme Filho: platform and infrastructure engineer working on hybrid cloud and automation.

A static, single-page site: plain HTML, CSS and a small JavaScript file. No framework, no build step, no third-party requests at runtime.

| | |
|---|---|
| **Live site** | <https://gfilho.net/> |
| **Stack** | HTML5, CSS, vanilla JavaScript · nginx (WSL, Ubuntu) · Cloudflare Tunnel |
| **Security** | Strict same-origin CSP, security headers, loopback-only origin, HTTPS-only canonical host |
| **Quality** | W3C-valid HTML and CSS · Lighthouse 100 accessibility, best practices and SEO |

![gfilho.net](site/og-image.png)

## Contents

- [Structure](#structure)
- [Hosting](#hosting)
- [Working on the site](#working-on-the-site)
- [Images](#images)
- [Security](#security)
- [Licenses](#licenses)

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
- **Sitemap:** `deploy.sh` sets `<lastmod>` in `site/sitemap.xml` to the current date whenever `index.html` differs from what is deployed. Commit the updated `sitemap.xml` together with the page.
- **security.txt:** `site/.well-known/security.txt` ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)) expires on 2027-10-18. `deploy.sh` warns 30 days before the `Expires:` date (and after it has passed) and prints a renewal date one year ahead; update the file by hand and deploy again.
- **Footer year:** set by `main.js` from the visitor's clock; the year written in the HTML is only a fallback for clients without JavaScript.
- **CSP:** the policy only allows same-origin resources. Inline `<script>` and `style=""` attributes are blocked; keep styles in `main.css` and code in `main.js`.

## Images

`og-image.png` (1200×630 social preview), the PNG icons and `favicon.ico` are generated from `tools/*.html`. On Windows with Google Chrome installed:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-images.ps1
```

## Security

Report security problems privately, as described in the [security policy](.github/SECURITY.md). Please do not open public issues for them.

## Licenses

| Content | License |
|---|---|
| Code and configuration: HTML structure, CSS, JavaScript, everything under `deploy/` and `tools/` | [MIT License](LICENSE) |
| Personal content: text, profile photo, logo and `og-image.png` | © Guilherme Filho, all rights reserved |
| Fonts: [Newsreader](https://github.com/productiontype/Newsreader) and [Hanken Grotesk](https://github.com/marcologous/hanken-grotesk) | SIL Open Font License 1.1 (`site/assets/fonts/OFL-*.txt`) |
| Icons: based on [Lucide](https://lucide.dev/) | ISC License (`site/assets/LICENSE-lucide.txt`) |
