# Compares what the dashboard shows (its queries, run through Grafana) with independent sources:
# the nginx access log parsed here, the cloudflared and stub_status endpoints, openssl, /proc, df,
# the backups folder and the systemd journal. Read-only.
#   sudo python3 monitoring/tests/check-values.py   (inside WSL, with the stack running)
import json, os, re, subprocess, time, urllib.request, datetime as dt
from collections import Counter

dash = json.load(open("/opt/gfilho-monitoring/grafana/dashboards/gfilho.json", encoding="utf-8"))
NOW = time.time()
panels = {}
def walk(ps):
    for p in ps:
        panels[p.get("title")] = p
        walk(p.get("panels", []))
walk(dash["panels"])

def grafana(title, ref="A", hours=24):
    t = next(x for x in panels[title]["targets"] if x["refId"] == ref)
    q = dict(t, expr=t["expr"].replace("$env", "production"), intervalMs=60000, maxDataPoints=800)
    now = int(time.time() * 1000)
    body = {"from": str(now - hours * 3600 * 1000), "to": str(now), "queries": [q]}
    req = urllib.request.Request("http://127.0.0.1:3000/api/ds/query", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    frames = json.load(urllib.request.urlopen(req, timeout=60))["results"][ref].get("frames", [])
    out = {}
    for f in frames:
        fields, vals = f["schema"]["fields"], f["data"]["values"]
        num = [i for i, x in enumerate(fields) if x.get("type") == "number"]
        for i in num:
            label = (fields[i].get("config") or {}).get("displayNameFromDS") or json.dumps(fields[i].get("labels") or {})
            series = [v for v in vals[i] if v is not None]
            if series:
                out[label] = series[-1]
    return out

def one(title, ref="A"):
    v = grafana(title, ref)
    return next(iter(v.values())) if v else None

def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()

results = []
def check(name, dash_value, truth, tol=0.0, rel=False, fmt=lambda x: f"{x:.6g}"):
    if dash_value is None or truth is None:
        ok = False
    else:
        diff = abs(dash_value - truth)
        ok = diff <= (abs(truth) * tol if rel else tol)
    results.append(ok)
    print(f"{'MATCH' if ok else 'DIFF '}  {name:<38} dashboard={fmt(dash_value) if dash_value is not None else 'None':<16} source={fmt(truth) if truth is not None else 'None'}")

# ---------------------------------------------------------------- traffic: parse the access log independently
NOISE = re.compile(r"gfilho-monitor|curl/|[Pp]ython-urllib|HeadlessChrome|Chrome-Lighthouse")
LINE = re.compile(r'^\S+ - \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) (\d+) "([^"]*)" "([^"]*)"')
LOCAL = re.compile(r"^https?://(localhost|127\.0\.0\.1)([:/].*)?$")
PAGE = re.compile(r"^/(cases/[a-z0-9-]+/)?$")
ASSET1 = re.compile(r"^/(assets|cdn-cgi)/.*")
ASSET2 = re.compile(r".*\.(png|ico|svg|xml|txt|webmanifest|jpg|woff2|js|css|map)$")
BOT = re.compile(r"(?i).*(bot|crawl|spider|slurp|facebookexternalhit|preview|feed|monitor|scan|python|go-http|wget).*")
SELF = re.compile(r"^https?://(www\.)?gfilho\.net.*")
rows = []
with open("/var/log/nginx/access.log", encoding="utf-8", errors="replace") as f:
    for line in f:
        if NOISE.search(line):
            continue
        m = LINE.match(line)
        if not m:
            continue
        ts = dt.datetime.strptime(m.group(1), "%d/%b/%Y:%H:%M:%S %z").timestamp()
        if ts < NOW - 86400:
            continue
        _, method, path, status, size, ref, agent = m.groups()
        if LOCAL.match(ref):
            continue
        rows.append((re.sub(r"\?.*$", "", path), status, int(size), ref, agent))
views = [r for r in rows if r[1] in ("200", "304") and PAGE.match(r[0])]
check("Page views (24 h)", one("Health", "G"), len(views), tol=3)
check("Data served (24 h, bytes)", one("Health", "H"), sum(r[2] for r in rows), tol=0.01, rel=True)
classes = Counter(r[1][0] + "xx" for r in rows)
for ref, k in zip("ABCD", ["2xx", "3xx", "4xx", "5xx"]):
    if classes.get(k, 0) or one("Status mix", ref) is not None:
        check(f"Status mix · {k}", one("Status mix", ref), classes.get(k, 0), tol=3)
humans = sum(1 for r in views if not BOT.match(r[4]))
bots = len(views) - humans
check("Humans vs bots · browsers", one("Humans vs bots", "A"), humans, tol=3)
check("Humans vs bots · bots", one("Humans vs bots", "B"), bots, tol=2)
top404 = Counter(r[0] for r in rows if r[1] == "404")
d404 = grafana("Top 404s")
for path, n in top404.most_common(3):
    dv = next((v for lbl, v in d404.items() if lbl == path), None)
    check(f"Top 404s · {path[:28]}", dv, n, tol=1)
toppages = Counter(r[0] for r in rows if r[1] in ("200", "304") and not ASSET1.match(r[0]) and not ASSET2.match(r[0]))
dpages = grafana("Top pages")
for path, n in toppages.most_common(3):
    dv = next((v for lbl, v in dpages.items() if lbl == path), None)
    check(f"Top pages · {path[:30]}", dv, n, tol=3)
refs = Counter(r[3] for r in views if r[3] != "-" and not SELF.match(r[3]))
drefs = grafana("Top referrers")
for ref, n in refs.most_common(2):
    dv = next((v for lbl, v in drefs.items() if lbl == ref), None)
    check(f"Top referrers · {ref[:26]}", dv, n, tol=1)

# ---------------------------------------------------------------- site, tunnel, nginx
cf = urllib.request.urlopen("http://127.0.0.1:20241/metrics", timeout=10).read().decode()
check("Tunnel connections", one("Health", "C"), float(re.search(r"^cloudflared_tunnel_ha_connections (\S+)", cf, re.M).group(1)))
edges = sorted(set(re.findall(r'cloudflared_tunnel_server_locations\{[^}]*edge_location="([^"]+)"', cf)))
print(f"{'MATCH' if edges else 'DIFF '}  {'Edge locations (source list)':<38} {edges}")
stub = urllib.request.urlopen("http://127.0.0.1:8090/stub_status", timeout=10).read().decode()
check("nginx active connections", grafana("nginx connections", "A") and one("nginx connections", "A"), float(re.search(r"Active connections: (\d+)", stub).group(1)), tol=2)
code = sh("curl -s -o /dev/null -w '%{http_code}' -A gfilho-monitor/1.0 https://gfilho.net/")
check("Site status (1 = UP)", one("Health", "A"), 1.0 if code == "200" else 0.0)
code = sh("curl -s -o /dev/null -w '%{http_code}' -A gfilho-monitor/1.0 http://127.0.0.1:8088/")
check("Origin status (1 = UP)", one("Health", "B"), 1.0 if code == "200" else 0.0)
rt = float(sh("curl -s -o /dev/null -w '%{time_total}' -A gfilho-monitor/1.0 https://gfilho.net/"))
check("Response time (s, ballpark)", one("Health", "D"), rt, tol=0.25)
na = sh("echo | openssl s_client -connect gfilho.net:443 -servername gfilho.net 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2")
cert_left = dt.datetime.strptime(na, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc).timestamp() - time.time()
check("TLS certificate (days left)", (one("Lifecycle", "A") or 0) / 86400, cert_left / 86400, tol=0.1, fmt=lambda x: f"{x:.2f}")
exp = re.search(r"^Expires:\s*(\S+)", open("/var/www/html/.well-known/security.txt").read(), re.M).group(1)
sec_left = dt.datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() - time.time()
check("security.txt (days left)", (one("Lifecycle", "B") or 0) / 86400, sec_left / 86400, tol=0.1, fmt=lambda x: f"{x:.2f}")

# ---------------------------------------------------------------- host and publishing
up = float(open("/proc/uptime").read().split()[0])
check("WSL uptime (s)", one("Lifecycle", "D"), up, tol=120)
files = int(sh("find /var/www/html -type f -o -type l | wc -l"))
check("Published files", one("Publishing", "A"), files)
size = int(sh("find /var/www/html \\( -type f -o -type l \\) -printf '%s\\n' | awk '{s+=$1} END {print s}'"))
check("Site size (bytes)", one("Publishing", "B"), size)
snaps = int(sh("find /var/backups/gfilho -mindepth 1 -maxdepth 1 -type d | wc -l"))
check("Backup snapshots", one("Publishing", "C"), snaps)
bsize = int(sh("find /var/backups/gfilho \\( -type f -o -type l \\) -printf '%s\\n' | awk '{s+=$1} END {print s}'"))
check("Backup size (bytes)", one("Publishing", "D"), bsize, tol=0.01, rel=True)
last = sorted(d for d in os.listdir("/var/backups/gfilho") if re.match(r"\d{8}-\d{6}-production$", d))[-1]
ago = time.time() - time.mktime(time.strptime(last[:15], "%Y%m%d-%H%M%S"))
check("Last deploy (s ago)", one("Lifecycle", "C"), ago, tol=180)
sec = int(sh("apt list --upgradable 2>/dev/null | grep 'upgradable from' | awk '{print $1}' | grep -c -- '-security'"))
check("Security updates", one("Lifecycle", "G"), sec)
mem = sh("free -b | awk '/^Mem:/ {print $2 - $7}'")
check("Memory used (bytes)", one("Memory", "A"), float(mem), tol=0.05, rel=True)
df = sh("df -B1 --output=used,size,avail / | tail -1").split()
check("Disk used (share, like df)", one("CPU & disk", "B"), int(df[0]) / (int(df[0]) + int(df[2])), tol=0.002)
boots = json.loads(sh("journalctl --list-boots -o json"))
rng = sorted((int(b["first_entry"]) / 1e6, int(b["last_entry"]) / 1e6) for b in boots)
start = NOW - 86400
off = sum(max(0.0, s2 - max(e1, start)) for (_s1, e1), (s2, _e2) in zip(rng, rng[1:]) if s2 > start)
check("WSL downtime 24 h (s)", one("Lifecycle", "E"), off, tol=300)

print(f"\n{sum(results)}/{len(results)} values match their source")
