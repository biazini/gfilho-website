# Runs every query of the installed dashboard (and its annotations) through Grafana's /api/ds/query,
# the way the panels do, and reports errors, warnings and unexpected empty results. Read-only.
#   python3 monitoring/tests/check-queries.py        (inside WSL, with the stack running)
import json, sys, time, urllib.request, urllib.error
ENV = sys.argv[1] if len(sys.argv) > 1 else "production"
dash = json.load(open("/opt/gfilho-monitoring/grafana/dashboards/gfilho.json", encoding="utf-8"))
now = int(time.time() * 1000)
FROM = now - 24 * 3600 * 1000
EXPECT_EMPTY = {("Alert details", "A"), ("Status mix", "D")}   # no firing alert and no 5xx are the healthy state

def panels(ps):
    for p in ps:
        yield p
        yield from panels(p.get("panels", []))

def query(t):
    q = dict(t)
    q["expr"] = q["expr"].replace("$env", ENV)
    q.update({"intervalMs": 60000, "maxDataPoints": 800})
    body = {"from": str(FROM), "to": str(now), "queries": [q]}
    req = urllib.request.Request("http://127.0.0.1:3000/api/ds/query", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=60))["results"][q["refId"]]
    except urllib.error.HTTPError as e:
        return "HTTP %d %s" % (e.code, e.read()[:200].decode(errors="replace")), [], []
    if r.get("error"):
        return r["error"][:200], [], []
    nums, notices = [], []
    for f in r.get("frames", []):
        for fld, vals in zip(f["schema"]["fields"], f["data"]["values"]):
            if fld.get("type") == "number":
                nums += [v for v in vals if v is not None]
        notices += [n.get("text", "")[:120] for n in (f["schema"].get("meta") or {}).get("notices", []) or [] if n.get("severity") in ("error", "warning")]
    return None, r.get("frames", []), (nums, notices)

bad = total = 0
for p in panels(dash["panels"]):
    for t in p.get("targets", []):
        total += 1
        err, frames, extra = query(t)
        nums, notices = extra if extra else ([], [])
        rng = f"{min(nums):.4g} … {max(nums):.4g}" if nums else "-"
        if err:
            status = "ERROR"
        elif notices:
            status = "WARN "
        elif not frames and (p["title"], t["refId"]) not in EXPECT_EMPTY:
            status = "EMPTY"
        else:
            status = "ok   "
        if status != "ok   ":
            bad += 1
        print(f"{status} [{p['type'][:10]:<10}] {p['title'][:34]:<34} {t['refId']} frames={len(frames):<3} values={rng:<22} {err or '; '.join(notices) or ''}")
for a in dash["annotations"]["list"][1:]:
    total += 1
    err, frames, _ = query({"refId": "A", "datasource": a["datasource"], "expr": a["expr"], "range": True, "instant": False})
    print(f"{'ERROR' if err else 'ok   '} [annotation] {a['name']:<34} A frames={len(frames)} {err or ''}")
    bad += bool(err)
print(f"\n{ENV}: {total - bad}/{total} queries ok")
