# Times every query of the installed dashboards through Grafana's /api/ds/query, the way the panels
# send them, for 1 h, 24 h and 7 d. Loki queries also report the bytes and lines Loki had to read.
# Read-only. Writes the raw numbers to the JSON file given as argument (for before/after comparisons).
#   python3 monitoring/tests/query-timings.py [timings.json]      (inside WSL, with the stack running)
import glob, json, re, statistics, sys, time, urllib.request

DIR = "/opt/gfilho-monitoring/grafana/dashboards"
RANGES = {"1h": 3600, "24h": 86400, "7d": 7 * 86400}
REPEAT = 3
UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}

def seconds(text):
    m = re.fullmatch(r"(\d+)([smhd])", text or "")
    return int(m.group(1)) * UNITS[m.group(2)] if m else 0

def nice(sec):            # Grafana rounds the calculated interval to a "nice" value
    for step in (1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600, 43200, 86400):
        if sec <= step * 1.5:
            return step
    return 86400

def panels(ps):
    for p in ps:
        yield p
        yield from panels(p.get("panels", []))

def run(t, panel, rng):
    now = int(time.time() * 1000)
    points = panel.get("maxDataPoints") or 1000
    min_iv = seconds(panel.get("interval")) or (30 if t["datasource"]["uid"] == "prometheus" else 1)
    q = dict(t, intervalMs=max(nice(rng / points), min_iv) * 1000, maxDataPoints=points)
    body = json.dumps({"from": str(now - rng * 1000), "to": str(now), "queries": [q]}).encode()
    req = urllib.request.Request("http://127.0.0.1:3000/api/ds/query", data=body, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    try:
        res = json.load(urllib.request.urlopen(req, timeout=120))["results"][t["refId"]]
    except urllib.error.HTTPError as e:
        return (time.perf_counter() - t0) * 1000, {"error": f"HTTP {e.code}"}
    ms = (time.perf_counter() - t0) * 1000
    out = {"frames": len(res.get("frames", [])), "error": res.get("error")}
    for f in res.get("frames", []):
        for s in (f["schema"].get("meta") or {}).get("stats", []) or []:
            name = s.get("displayName", "")
            if name in ("Summary: total bytes processed", "Summary: total lines processed"):
                key = "bytes" if "bytes" in name else "lines"
                out[key] = max(out.get(key, 0), s.get("value", 0))
    return ms, out

rows = []
for path in sorted(glob.glob(f"{DIR}/*.json")):
    dash = json.load(open(path, encoding="utf-8"))
    for p in panels(dash["panels"]):
        for t in p.get("targets", []):
            row = {"dashboard": dash["uid"], "panel": p["title"], "ref": t["refId"], "ds": t["datasource"]["uid"], "expr": t["expr"]}
            for name, rng in RANGES.items():
                times, info = [], {}
                for _ in range(REPEAT):
                    ms, info = run(t, p, rng)
                    times.append(ms)
                row[name] = {"ms": round(statistics.median(times), 1), **info}
            rows.append(row)
            print(f"{row['dashboard'][:16]:<16} {row['ds'][:4]} {row['panel'][:30]:<30} {row['ref']}  " +
                  "  ".join(f"{n} {row[n]['ms']:7.1f} ms" + (f" {row[n].get('bytes', 0)/1024:7.0f} KiB" if row['ds'] == 'loki' else "") for n in RANGES))
    total = {n: sum(r[n]["ms"] for r in rows if r["dashboard"] == dash["uid"]) for n in RANGES}
    print(f"-- {dash['uid']}: {sum(1 for r in rows if r['dashboard'] == dash['uid'])} queries, refresh {dash.get('refresh')}, server time per full load: " +
          ", ".join(f"{n} {v/1000:.2f} s" for n, v in total.items()) + "\n")
if len(sys.argv) > 1:
    json.dump(rows, open(sys.argv[1], "w"), indent=1)
