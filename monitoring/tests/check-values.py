# Compares what the dashboards show (their queries, run through Grafana for the last 24 h) with
# independent sources: the nginx access logs parsed here, the Prometheus and cloudflared APIs, the
# stub_status page, openssl, systemctl, /proc, df, the backups folder and the systemd journal. Read-only.
#   sudo python3 monitoring/tests/check-values.py   (inside WSL, with the stack running)
import glob, json, os, re, subprocess, time, urllib.parse, urllib.request, datetime as dt
from collections import Counter

NOW = time.time()
panels = {}
def walk(ps):
    for p in ps:
        panels[p.get("title")] = p
        walk(p.get("panels", []))
for path in glob.glob("/opt/gfilho-monitoring/grafana/dashboards/*.json"):
    walk(json.load(open(path, encoding="utf-8"))["panels"])

def target(title, ref="A"):
    return next(x for x in panels[title]["targets"] if x["refId"] == ref)

def grafana(title, ref="A", expr=None, instant=None, by_labels=None):
    """{series name: last value} for one panel query, named by its legend or, without one, its labels."""
    t = dict(target(title, ref))
    if expr:
        t["expr"] = expr
    if instant:
        t.update(instant=True, range=False, queryType="instant")
    q = dict(t, intervalMs=60000, maxDataPoints=800)
    now = int(time.time() * 1000)
    body = {"from": str(now - 86400 * 1000), "to": str(now), "queries": [q]}
    req = urllib.request.Request("http://127.0.0.1:3000/api/ds/query", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    frames = json.load(urllib.request.urlopen(req, timeout=60))["results"][ref].get("frames", [])
    out = {}
    for f in frames:
        fields, vals = f["schema"]["fields"], f["data"]["values"]
        for i, fld in enumerate(fields):
            if fld.get("type") != "number":
                continue
            label = (fld.get("config") or {}).get("displayNameFromDS") or json.dumps(fld.get("labels") or {}, sort_keys=True)
            if by_labels:
                label = tuple((fld.get("labels") or {}).get(k) for k in by_labels)
            series = [v for v in vals[i] if v is not None]
            if series:
                out[label] = series[-1]
    return out

def one(title, ref="A"):
    v = grafana(title, ref)
    return next(iter(v.values())) if v else None

def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()

def api(url):
    return json.load(urllib.request.urlopen(url, timeout=30))

def prom(expr):
    return api("http://127.0.0.1:9091/api/v1/query?" + urllib.parse.urlencode({"query": expr}))["data"]["result"]

results = []
def check(name, dash_value, truth, tol=0.0, rel=False, fmt=lambda x: f"{x:.6g}"):
    if dash_value is None or truth is None:
        ok = False
    else:
        diff = abs(dash_value - truth)
        ok = diff <= (abs(truth) * tol if rel else tol)
    results.append(ok)
    print(f"{'MATCH' if ok else 'DIFF '}  {name:<40} dashboard={fmt(dash_value) if dash_value is not None else 'None':<16} source={fmt(truth) if truth is not None else 'None'}")

# ---------------------------------------------------------------- traffic: parse the access logs independently
NOISE = re.compile(r"gfilho-monitor|curl/|ython-urllib|HeadlessChrome|Chrome-Lighthouse|self-audit")
LINE = re.compile(r'^\S+ - \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) (\d+) "([^"]*)" "([^"]*)"')
LOCAL = re.compile(r"^https?://(localhost|127\.0\.0\.1)([:/].*)?$")
PAGE = re.compile(r"^/(cases/[a-z0-9-]+/)?$")
ASSET1 = re.compile(r"^/(assets|cdn-cgi)/.*")
ASSET2 = re.compile(r".*\.(png|ico|svg|xml|txt|webmanifest|jpg|woff2|js|css|map)$")
SELF = re.compile(r"^https?://(www\.)?gfilho\.net.*")
# the two User-Agent patterns are the dashboard's own (a design choice); what is checked is that Loki applies them right
BOT_RE, BROWSER_RE = (re.compile(r) for r in re.findall(r'count "([^"]+)" \.agent', target("Clients")["expr"]))

def log_lines(name):
    # the 24 h window spans the current log and the one logrotate rotated last night
    for f in (f"/var/log/nginx/{name}.1", f"/var/log/nginx/{name}"):
        if os.path.exists(f):
            with open(f, encoding="utf-8", errors="replace") as fh:
                yield from fh

def recent(name):
    for line in log_lines(name):
        m = LINE.match(line)
        if m and dt.datetime.strptime(m.group(1), "%d/%b/%Y:%H:%M:%S %z").timestamp() >= NOW - 86400:
            yield line, m

rows, sources = [], Counter()
for line, m in recent("access.log"):
    _, method, path, status, size, ref, agent = m.groups()
    if "gfilho-monitor" in agent:
        sources["Monitoring probes"] += 1
    elif NOISE.search(line):
        sources["Automated tools"] += 1
    elif LOCAL.match(ref):
        sources["Local previews"] += 1
    else:
        sources["Visitors"] += 1
        rows.append((re.sub(r"\?.*$", "", path), status, int(size), ref, agent, method, path))
sources["Staging"] = sum(1 for _ in recent("gfilho-staging.access.log"))
views = [r for r in rows if r[1] in ("200", "304") and PAGE.match(r[0])]

check("Page views (24 h)", one("Visitor traffic", "A"), len(views), tol=3)
check("Requests (24 h)", one("Visitor traffic", "B"), len(rows), tol=5)
check("Data served (24 h, bytes)", one("Visitor traffic", "C"), sum(r[2] for r in rows), tol=0.01, rel=True)
check("404 responses (24 h)", one("Visitor traffic", "D"), sum(1 for r in rows if r[1] == "404"), tol=3)
n5 = sum(1 for r in rows if r[1].startswith("5"))
check("5xx responses (24 h)", one("Visitor traffic", "E") or 0, n5)
check("5xx share (24 h)", one("Visitor traffic", "F"), n5 / len(rows) if rows else 0, tol=0.001)
probe5 = sum(1 for line, m in recent("access.log") if "gfilho-monitor" in line and dt.datetime.strptime(m.group(1), "%d/%b/%Y:%H:%M:%S %z").timestamp() >= time.time() - 300)
check("Log pipeline (probe lines, 5 min)", one("Visitor traffic", "G"), float(probe5), tol=4)
mix = grafana("Status mix")
classes = Counter(r[1][0] + "xx" for r in rows)
for k in ("2xx", "3xx", "4xx", "5xx"):
    if classes.get(k) or k in mix:
        check(f"Status mix · {k}", mix.get(k), classes.get(k, 0), tol=3)
clients = grafana("Clients")
truth = Counter("Bots & tools" if BOT_RE.search(r[4]) else "Browsers" if BROWSER_RE.search(r[4]) else "Unclassified" for r in views)
for k in ("Browsers", "Bots & tools", "Unclassified"):
    check(f"Clients · {k}", clients.get(k, 0), truth.get(k, 0), tol=2)
src_expr = target("Request sources")["expr"].replace("rate(", "count_over_time(", 1).replace("[$__auto])) * 3600", "[24h]))")
src = grafana("Request sources", expr=src_expr, instant=True)
for k in ("Visitors", "Monitoring probes", "Automated tools", "Local previews", "Staging"):
    if sources.get(k) or k in src:
        check(f"Request sources · {k} (24 h)", src.get(k, 0), sources.get(k, 0), tol=max(3, sources.get(k, 0) * 0.01))
top404 = Counter(r[0] for r in rows if r[1] == "404")
d404 = grafana("Top 404s")
for path, n in top404.most_common(3):
    check(f"Top 404s · {path[:30]}", d404.get(path), n, tol=1)
toppages = Counter(r[0] for r in rows if r[1] in ("200", "304") and not ASSET1.match(r[0]) and not ASSET2.match(r[0]))
dpages = grafana("Top pages")
for path, n in toppages.most_common(3):
    check(f"Top pages · {path[:30]}", dpages.get(path), n, tol=3)
refs = Counter(r[3] for r in views if r[3] != "-" and not SELF.match(r[3]))
drefs = grafana("Top referrers")
for ref, n in refs.most_common(2):
    check(f"Top referrers · {ref[:28]}", drefs.get(ref), n, tol=1)
unusual = Counter((r[5], r[1], r[6]) for r in rows if (r[1].startswith("4") and r[1] != "404") or r[1].startswith("5") or r[5] not in ("GET", "HEAD"))
dun = grafana("Unusual requests", by_labels=("method", "status", "path"))
for key, n in unusual.most_common(2):
    check(f"Unusual · {' '.join(key)[:32]}", dun.get(key), n, tol=1)

# ---------------------------------------------------------------- overview: probes, tunnel, lifecycle
def code(url):
    return sh(f"curl -s -o /dev/null -w '%{{http_code}}' -A gfilho-monitor/1.0 {url}")
pages = ["https://gfilho.net/", "https://gfilho.net/cases/self-healing/", "https://gfilho.net/cases/ascender-k3s/"]
check("Public site (1 = all pages UP)", one("Status", "A"), 1.0 if all(code(u) == "200" for u in pages) else 0.0)
check("Origin (1 = UP)", one("Status", "B"), 1.0 if code("http://127.0.0.1:8088/") == "200" else 0.0)
cf = urllib.request.urlopen("http://127.0.0.1:20241/metrics", timeout=10).read().decode()
check("Tunnel links", one("Status", "C"), float(re.search(r"^cloudflared_tunnel_ha_connections (\S+)", cf, re.M).group(1)))
rt = float(sh("curl -s -o /dev/null -w '%{time_total}' -A gfilho-monitor/1.0 https://gfilho.net/"))
check("Response time (s, ballpark)", one("Status", "D"), rt, tol=0.25)
# raw probe samples of the last 24 h, straight from Prometheus, aggregated here
raw = prom('probe_duration_seconds{job="blackbox_public", instance="https://gfilho.net/"}[24h]')
def quantile(q, vs):
    vs = sorted(vs); rank = q * (len(vs) - 1); lo = int(rank); hi = min(lo + 1, len(vs) - 1)
    return vs[lo] + (vs[hi] - vs[lo]) * (rank - lo)
check("p95 response time (24 h, s)", one("Status", "E"), max(quantile(0.95, [float(v) for _, v in s["values"]]) for s in raw), tol=0.02, rel=True)
succ = [float(v) for s in prom('probe_success{job="blackbox_public", instance="https://gfilho.net/"}[24h]') for _, v in s["values"]]
check("Availability (24 h, while monitored)", one("Status", "F"), sum(succ) / len(succ), tol=0.002)
check("Monitored share of 24 h", one("Status", "G"), min(1.0, len(succ) / 1440), tol=0.01)
check("Alerts firing", one("Status", "H"), float(sum(1 for a in api("http://127.0.0.1:9091/api/v1/alerts")["data"]["alerts"] if a["state"] == "firing")))
na = sh("echo | openssl s_client -connect gfilho.net:443 -servername gfilho.net 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2")
cert_left = dt.datetime.strptime(na, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc).timestamp() - time.time()
check("TLS certificate (days left)", (one("Lifecycle", "A") or 0) / 86400, cert_left / 86400, tol=0.1, fmt=lambda x: f"{x:.2f}")
exp = re.search(r"^Expires:\s*(\S+)", open("/var/www/html/.well-known/security.txt").read(), re.M).group(1)
sec_left = dt.datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() - time.time()
check("security.txt (days left)", (one("Lifecycle", "B") or 0) / 86400, sec_left / 86400, tol=0.1, fmt=lambda x: f"{x:.2f}")
last = sorted(d for d in os.listdir("/var/backups/gfilho") if re.match(r"\d{8}-\d{6}-production$", d))[-1]
ago = time.time() - time.mktime(time.strptime(last[:15], "%Y%m%d-%H%M%S"))
check("Last deploy (s ago)", one("Lifecycle", "C"), ago, tol=180)
boots = json.loads(sh("journalctl --list-boots -o json"))
rng = sorted((int(b["first_entry"]) / 1e6, int(b["last_entry"]) / 1e6) for b in boots)
start = NOW - 86400
off = sum(max(0.0, s2 - max(e1, start)) for (_s1, e1), (s2, _e2) in zip(rng, rng[1:]) if s2 > start)
check("WSL offline 24 h (s)", one("Lifecycle", "D"), off, tol=300)

# ---------------------------------------------------------------- infrastructure
def unit(name):
    state = sh(f"systemctl is-active {name}")
    return 1.0 if state == "active" else -1.0 if state == "failed" else 0.0
for ref, name in zip("ABCD", ("nginx.service", "cloudflared.service", "docker.service", "gfilho-metrics.timer")):
    check(f"Service · {name}", one("Services now", ref), unit(name))
check("Failed units", one("Services now", "E"), float(len([l for l in sh("systemctl --failed --no-legend --plain").splitlines() if re.match(r"(nginx|cloudflared|docker|logrotate|gfilho-metrics)\.", l)])))
check("WSL running for (s)", one("Services now", "H"), float(open("/proc/uptime").read().split()[0]), tol=120)
check("Tunnel links (infra)", one("Tunnel now", "A"), float(re.search(r"^cloudflared_tunnel_ha_connections (\S+)", cf, re.M).group(1)))
rtts = [float(v) for v in re.findall(r"^quic_client_smoothed_rtt\{[^}]*\} (\S+)", cf, re.M)]
check("Edge RTT (ms, average)", one("Tunnel now", "B"), sum(rtts) / len(rtts) if rtts else None, tol=15)
edges = sorted(set(re.findall(r'cloudflared_tunnel_server_locations\{[^}]*edge_location="([^"]+)"', cf)))
print(f"{'MATCH' if edges else 'DIFF '}  {'Edge locations (source list)':<40} {edges}")
stub = urllib.request.urlopen("http://127.0.0.1:8090/stub_status", timeout=10).read().decode()
check("nginx active connections", one("nginx connections", "A"), float(re.search(r"Active connections: (\d+)", stub).group(1)), tol=2)
mem = sh("free -b | awk '/^Mem:/ {print $2 - $7}'")
check("Memory used (bytes)", one("Memory", "A"), float(mem), tol=0.05, rel=True)
for ref, mp in (("A", "/"), ("B", "/mnt/c")):
    df = sh(f"df -B1 --output=used,size,avail {mp} | tail -1").split()
    check(f"Disk used {mp} (share, like df)", one("Disk space", ref), int(df[0]) / (int(df[0]) + int(df[2])), tol=0.002)
files = int(sh("find /var/www/html -type f -o -type l | wc -l"))
check("Published files", one("Publishing & backups", "A"), files)
size = int(sh("find /var/www/html \\( -type f -o -type l \\) -printf '%s\\n' | awk '{s+=$1} END {print s}'"))
check("Site size (bytes)", one("Publishing & backups", "B"), size)
snaps = sorted(d for d in os.listdir("/var/backups/gfilho") if os.path.isdir(f"/var/backups/gfilho/{d}"))
check("Backup snapshots", one("Publishing & backups", "C"), len(snaps))
bsize = int(sh("find /var/backups/gfilho \\( -type f -o -type l \\) -printf '%s\\n' | awk '{s+=$1} END {print s}'"))
check("Backup size (bytes)", one("Publishing & backups", "D"), bsize, tol=0.01, rel=True)
newest = max(time.mktime(time.strptime(d[:15], "%Y%m%d-%H%M%S")) for d in snaps if re.match(r"\d{8}-\d{6}-", d))
check("Newest snapshot (s ago)", one("Publishing & backups", "E"), time.time() - newest, tol=180)
check("Scrape targets down", one("Monitoring pipeline", "A"), float(sum(1 for t in api("http://127.0.0.1:9091/api/v1/targets")["data"]["activeTargets"] if t["health"] != "up")))
check("Custom metrics age (s)", one("Monitoring pipeline", "D"), time.time() - os.path.getmtime("/var/lib/gfilho-monitoring/textfile/gfilho.prom"), tol=60)
sec = int(sh("apt list --upgradable 2>/dev/null | grep 'upgradable from' | awk '{print $1}' | grep -c -- '-security'"))
check("Security updates", one("Maintenance", "A"), sec)

print(f"\n{sum(results)}/{len(results)} values match their source")
