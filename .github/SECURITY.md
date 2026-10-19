# Security Policy

## Scope

This repository holds the source of [gfilho.net](https://gfilho.net/): a static website, its nginx configuration and the scripts used to publish it. Security reports are welcome for anything here that could weaken the site or the server that hosts it, for example:

- a configuration that exposes a service, file or path that should not be public;
- a missing or weaker-than-documented security header (CSP, framing, content-type, referrer or permissions policy);
- a redirect, cache or TLS-related setting that can be abused;
- a deploy script that could publish or delete the wrong files;
- a script, style or asset that loads content from a third party.

## Supported versions

| Release | Supported |
|---|---|
| Current `main` (what runs on gfilho.net) | ✅ |

## Reporting a vulnerability

Please **do not** disclose security problems publicly. Report them privately through GitHub:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**, or go directly to <https://github.com/biazini/gfilho-website/security/advisories/new>.
3. Describe the affected file or URL, the risk, and a suggested correction if you have one.

Reports are reviewed on a best-effort basis. Confirmed problems are fixed on the live site and in this repository, and the reporter is credited unless they prefer otherwise.

## Vulnerabilities in upstream components

Vulnerabilities in the software the site runs on must be reported to their maintainers, not here:

- nginx: <https://nginx.org/en/security_advisories.html>
- Cloudflare (including Cloudflare Tunnel / `cloudflared`): <https://www.cloudflare.com/disclosure/>
