#!/usr/bin/env python3
"""Custom gfilho_* metrics for the Grafana dashboard, written for node_exporter's textfile collector.

Installed as /usr/local/sbin/gfilho-metrics and run every 2 minutes by gfilho-metrics.timer (as root).
Only reads the system; the single file it writes is OUT. Standard library only.
"""
import datetime as dt
import json
import os
import re
import subprocess
import time

OUT = "/var/lib/gfilho-monitoring/textfile/gfilho.prom"
WEB = "/var/www/html"
BACKUPS = "/var/backups/gfilho"
lines = []


def metric(name, help_text, kind, samples):
    lines.append(f"# HELP {name} {help_text}")
    lines.append(f"# TYPE {name} {kind}")
    for labels, value in samples:
        lab = ",".join(f'{k}="{str(v).replace(chr(34), "")}"' for k, v in labels.items())
        lines.append(f"{name}{{{lab}}} {value}" if lab else f"{name} {value}")


def run(cmd):
    """stdout and stderr of a command ("" if it cannot run); nginx -v prints to stderr."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return p.stdout + p.stderr
    except Exception:
        return ""


def tree_size(path):
    files, size = 0, 0
    for root, _dirs, names in os.walk(path):
        for n in names:
            try:
                size += os.lstat(os.path.join(root, n)).st_size
                files += 1
            except OSError:
                pass
    return files, size


# security.txt expiry (RFC 9116 "Expires:")
try:
    with open(f"{WEB}/.well-known/security.txt", encoding="utf-8") as f:
        m = re.search(r"^Expires:\s*(\S+)", f.read(), re.M)
    expires = dt.datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).timestamp()
    metric("gfilho_security_txt_expires_timestamp_seconds", "Expires date of /.well-known/security.txt", "gauge", [({}, expires)])
except Exception:
    pass

# published site
files, size = tree_size(WEB)
metric("gfilho_site_files", "Files in the production web root", "gauge", [({}, files)])
metric("gfilho_site_bytes", "Size of the production web root", "gauge", [({}, size)])

# deploy snapshots: <YYYYmmdd-HHMMSS>-<kind>
counts, last = {}, {}
_, backup_bytes = tree_size(BACKUPS)
for entry in os.scandir(BACKUPS) if os.path.isdir(BACKUPS) else []:
    if not entry.is_dir():
        continue
    m = re.match(r"(\d{8}-\d{6})-(.+)$", entry.name)
    kind = m.group(2) if m else "other"
    counts[kind] = counts.get(kind, 0) + 1
    if m:
        ts = time.mktime(time.strptime(m.group(1), "%Y%m%d-%H%M%S"))
        last[kind] = max(last.get(kind, 0), ts)
metric("gfilho_backup_snapshots", "Snapshots under /var/backups/gfilho by kind", "gauge", [({"kind": k}, v) for k, v in sorted(counts.items())])
metric("gfilho_backup_bytes", "Total size of /var/backups/gfilho", "gauge", [({}, backup_bytes)])
metric("gfilho_last_deploy_timestamp_seconds", "Time of the latest deploy (its backup snapshot) by target", "gauge",
       [({"target": k}, v) for k, v in sorted(last.items()) if k in ("production", "staging", "nginx")])

# WSL availability from the journal: time with no running boot = website offline
try:
    boots = json.loads(run(["journalctl", "--list-boots", "-o", "json"]) or "[]")
    ranges = sorted((int(b["first_entry"]) / 1e6, int(b["last_entry"]) / 1e6) for b in boots)
    now = time.time()
    samples_off, samples_boots = [], []
    for window, seconds in (("24h", 86400), ("7d", 7 * 86400)):
        start = now - seconds
        off = sum(max(0.0, s2 - max(e1, start)) for (_s1, e1), (s2, _e2) in zip(ranges, ranges[1:]) if s2 > start)
        samples_off.append(({"window": window}, round(off)))
        samples_boots.append(({"window": window}, sum(1 for s, _e in ranges if s > start)))
    metric("gfilho_wsl_offline_seconds", "Time WSL was not running (website offline) in the window", "gauge", samples_off)
    metric("gfilho_wsl_boots", "WSL boots started in the window", "gauge", samples_boots)
except Exception:
    pass

# pending package updates (local APT cache, no refresh)
upg = [l for l in run(["apt", "list", "--upgradable"]).splitlines() if "/" in l and "upgradable from" in l]
metric("gfilho_apt_upgradable", "Upgradable packages (local APT cache)", "gauge",
       [({"kind": "all"}, len(upg)), ({"kind": "security"}, sum(1 for l in upg if "-security" in l.split()[0]))])
metric("gfilho_reboot_required", "1 when /var/run/reboot-required exists", "gauge", [({}, int(os.path.exists("/var/run/reboot-required")))])

# component versions (shown as a table on the dashboard)
versions = {}
m = re.search(r"nginx/(\S+)", run(["nginx", "-v"]))
if m:
    versions["nginx"] = m.group(1)
m = re.search(r"version (\S+)", run(["cloudflared", "--version"]))
if m:
    versions["cloudflared"] = m.group(1)
try:
    with open("/etc/os-release", encoding="utf-8") as f:
        versions["ubuntu"] = re.search(r'^VERSION="?([^"\n]+)', f.read(), re.M).group(1)
except Exception:
    pass
versions["kernel"] = os.uname().release
metric("gfilho_component_info", "Installed versions of the hosting components", "gauge",
       [({"component": k, "version": v}, 1) for k, v in sorted(versions.items())])

metric("gfilho_metrics_last_run_timestamp_seconds", "When this script last ran", "gauge", [({}, round(time.time()))])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
tmp = OUT + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
os.chmod(tmp, 0o644)
os.replace(tmp, OUT)
