# Runs every query of the installed dashboards (and their annotations) through Grafana's /api/ds/query,
# the way the panels send them, for the last 1 h, 24 h and 7 d. Reports errors, warnings and unexpected
# empty results. Read-only.
#   python3 monitoring/tests/check-queries.py [1h|24h|7d ...]     (inside WSL, with the stack running)
import glob, json, re, sys, time, urllib.request, urllib.error

DIR = "/opt/gfilho-monitoring/grafana/dashboards"
RANGES = {"1h": 3600, "24h": 86400, "7d": 7 * 86400}
WANT = sys.argv[1:] or list(RANGES)
# empty is the healthy state for these (no alert, no 5xx, nothing unusual, no nginx error); in short ranges any traffic panel can be empty
EXPECT_EMPTY = {("Alert history", "A"), ("Visitor traffic", "E"), ("Unusual requests", "A"), ("Unusual requests · raw lines", "A"), ("nginx errors", "A")}
UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}

def seconds(text):
    m = re.fullmatch(r"(\d+)([smhd])", text or "")
    return int(m.group(1)) * UNITS[m.group(2)] if m else 0

def nice(sec):
    for step in (1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600, 43200, 86400):
        if sec <= step * 1.5:
            return step
    return 86400

def panels(ps):
    for p in ps:
        yield p
        yield from panels(p.get("panels", []))

def query(t, panel, rng):
    now = int(time.time() * 1000)
    points = panel.get("maxDataPoints") or 1000
    min_iv = seconds(panel.get("interval")) or (30 if t["datasource"]["uid"] == "prometheus" else 1)
    q = dict(t, intervalMs=max(nice(rng / points), min_iv) * 1000, maxDataPoints=points)
    body = {"from": str(now - rng * 1000), "to": str(now), "queries": [q]}
    req = urllib.request.Request("http://127.0.0.1:3000/api/ds/query", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=120))["results"][q["refId"]]
    except urllib.error.HTTPError as e:
        return "HTTP %d %s" % (e.code, e.read()[:200].decode(errors="replace")), [], [], []
    if r.get("error"):
        return r["error"][:200], [], [], []
    nums, notices = [], []
    for f in r.get("frames", []):
        for fld, vals in zip(f["schema"]["fields"], f["data"]["values"]):
            if fld.get("type") == "number":
                nums += [v for v in vals if v is not None]
        notices += [n.get("text", "")[:120] for n in (f["schema"].get("meta") or {}).get("notices", []) or [] if n.get("severity") in ("error", "warning")]
    return None, r.get("frames", []), nums, notices

summary = {}
for path in sorted(glob.glob(f"{DIR}/*.json")):
    dash = json.load(open(path, encoding="utf-8"))
    print(f"== {dash['uid']} ({dash['title']})")
    for name in WANT:
        rng = RANGES[name]
        bad = total = empty = 0
        for p in panels(dash["panels"]):
            for t in p.get("targets", []):
                total += 1
                err, frames, nums, notices = query(t, p, rng)
                if err:
                    status = "ERROR"
                elif notices:
                    status = "WARN "
                elif not frames and (p["title"], t["refId"]) not in EXPECT_EMPTY:
                    empty += 1
                    status = "EMPTY" if name == "24h" else "ok   "     # 1 h may simply have had no traffic
                else:
                    status = "ok   "
                bad += status != "ok   "
                if status != "ok   " or name == "24h":
                    rng_txt = f"{min(nums):.4g} … {max(nums):.4g}" if nums else "-"
                    print(f"{status} {name:>3} [{p['type'][:10]:<10}] {p['title'][:34]:<34} {t['refId']} frames={len(frames):<3} values={rng_txt:<22} {err or '; '.join(notices)}")
        for a in dash["annotations"]["list"]:
            if "expr" not in a:
                continue
            total += 1
            err, frames, _, _ = query({"refId": "A", "datasource": a["datasource"], "expr": a["expr"], "range": True, "instant": False}, {"interval": a.get("step")}, rng)
            bad += bool(err)
            if err or name == "24h":
                print(f"{'ERROR' if err else 'ok   '} {name:>3} [annotation] {a['name']:<34} A frames={len(frames)} {err or ''}")
        summary[(dash["uid"], name)] = (total - bad, total, empty)
    print()
for (uid, name), (ok, total, empty) in summary.items():
    print(f"{uid:<18} {name:>3}: {ok}/{total} queries ok" + (f" ({empty} without data in this range)" if empty and name != "24h" else ""))
ok = sum(v[0] for v in summary.values()); total = sum(v[1] for v in summary.values())
print(f"\nall dashboards, {', '.join(WANT)}: {ok}/{total} queries ok")
sys.exit(0 if ok == total else 1)
