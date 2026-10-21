// Source of the provisioned (read-only) gfilho.net dashboard, monitoring/grafana/dashboards/gfilho.json
// (uid gfilho-overview, the Grafana home page). One page, most urgent first: status, lifecycle, uptime and
// alerts at the top, then the sections Latency & traffic, Visitors & security, Services, Cloudflare Tunnel,
// Web server & probes, Host · WSL, Publishing & monitoring, and Logs (collapsed). Grafana only queries the
// panels in view, so the sections further down cost nothing until you scroll to them.
// Edit this file, then regenerate the JSON and reinstall:
//   node monitoring/grafana/build-dashboard.mjs monitoring/grafana/dashboards
//   sudo bash monitoring/install-monitoring.sh      # Grafana reloads the dashboards within a minute
// The build stops on duplicate ids or titles, overlapping or off-grid panels, unknown panel types, unknown
// data sources and links to localhost. Check the result with monitoring/tests/check-queries.py,
// check-values.py and query-timings.py.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node build-dashboard.mjs <output directory>'); process.exit(1); }
const PROM = { type: 'prometheus', uid: 'prometheus' };
const LOKI = { type: 'loki', uid: 'loki' };
const MIXED = { type: 'datasource', uid: '-- Mixed --' };
const DAY = 86400;
const C = { green: '#73BF69', amber: '#FF9830', red: '#F2495C', blue: '#5794F2', purple: '#B877D9', teal: '#2BC4B4', neutral: '#8AB8FF', grey: '#8E8E8E' };
const REQH = 'suffix: req/h';      // one unit for every request rate, so nginx, tunnel and log figures compare directly

let B;                             // the dashboard being built: its panels and id counter
let Y0 = 0;                        // each section is laid out from y = 0; below() moves that origin under the panels already placed
const pos = (x, y, w, h) => ({ x, y: y + Y0, w, h });
const th = (...steps) => ({ mode: 'absolute', steps: steps.map(([color, value]) => ({ color, value })) });
const prom = (expr, legend = '', extra = {}) => ({ datasource: PROM, expr, legendFormat: legend, ...extra });
const loki = (expr, legend = '', extra = {}) => ({ datasource: LOKI, expr, legendFormat: legend, ...extra });
const refAt = i => String.fromCharCode(65 + i);
const refs = ts => ts.map((t, i) => ({ refId: refAt(i), ...t }));
const forRef = (i, props) => ({ matcher: { id: 'byFrameRefID', options: refAt(i) }, properties: props });
const byRef = names => (names || []).map((n, i) => forRef(i, [{ id: 'displayName', value: n }]));
const byName = colors => Object.entries(colors).map(([n, c]) => ({ matcher: { id: 'byName', options: n }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: c } }] }));
const map = pairs => [{ type: 'value', options: Object.fromEntries(pairs.map(([v, text, color], i) => [String(v), { text, color, index: i }])) }];

// probe and unit states: UP / DOWN, plus UNKNOWN when Prometheus cannot reach the exporter (no sample is not "up")
const PROBE = map([[0, 'DOWN', C.red], [0.5, 'UNKNOWN', C.grey], [1, 'UP', C.green]]);
const PROBE_TH = th([C.red, null], [C.grey, 0.5], [C.green, 1]);
const OKFAIL = map([[0, 'Failing', C.red], [1, 'OK', C.green]]);
const SVC = map([[-1, 'FAILED', C.red], [0, 'STOPPED', C.red], [1, 'RUNNING', C.green]]);
const SVC_TH = th([C.red, null], [C.green, 1]);
const ZERO_OK = th([C.green, null], [C.red, 1]);                 // any value above 0 is a fault (errors, failed units)
// web.dev TTFB guidance: good up to 0.8 s, poor above 1.8 s. The probe measures DNS + connect + TLS + the whole
// response, so it is never faster than TTFB: these colours are on the safe side.
const LATENCY = th([C.green, null], [C.amber, 0.8], [C.red, 1.8]);
const STATUS_COLORS = { '2xx': C.green, '3xx': C.blue, '4xx': C.amber, '5xx': C.red };
const CODE_COLORS = [['2..', C.green], ['3..', C.blue], ['4..', C.amber], ['5..', C.red]].map(([re, c]) => ({ matcher: { id: 'byRegexp', options: re }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: c } }] }));

// ---------------------------------------------------------------- panel helpers
function board() { B = { id: 0, top: [] }; B.into = B.top; }
function below() { Y0 = 0; Y0 = Math.max(0, ...B.top.map(p => p.gridPos.y + (p.type === 'row' ? 1 : p.gridPos.h))); }
function push(p) { const panel = { id: ++B.id, ...p }; B.into.push(panel); return panel; }
function row(title, y, { collapsed = false } = {}) {
  const r = { id: ++B.id, type: 'row', title, collapsed, gridPos: pos(0, y, 24, 1), panels: [] };
  B.top.push(r);
  B.into = collapsed ? r.panels : B.top;
}
const instant = t => ({ instant: true, range: false, ...(t.datasource === LOKI ? { queryType: 'instant' } : {}), ...t });
const ranged = t => ({ range: true, instant: false, ...(t.datasource === LOKI ? { queryType: 'range' } : {}), ...t });

// One borderless strip of current values (instant queries: a stale value is not shown as current).
// Each item keeps its own unit, thresholds, mappings and "no data" text through per-query overrides.
// A query without result would make its item vanish from a multi-query stat (noValue only applies to a
// whole empty panel), so every Prometheus item falls back to NaN, shown as NO DATA; Loki counts fall back
// to 0 in their own expression (no matching line is a real zero; "Log pipeline" tells the two apart).
const noData = text => ({ type: 'special', options: { match: 'null+nan', result: { text, color: C.grey, index: 9 } } });
const orNaN = q => (q.datasource === PROM && !/or vector\(0\)$/.test(q.expr) ? { ...q, expr: `(${q.expr}) or on() vector(NaN)` } : q);
function strip(title, description, items, gridPos, { valueSize = 30, titleSize = 13 } = {}) {
  const ds = new Set(items.map(it => it.q.datasource.uid));
  return push({
    type: 'stat', title, description, gridPos, transparent: true, datasource: ds.size > 1 ? MIXED : items[0].q.datasource,
    targets: refs(items.map(it => instant(orNaN(it.q)))),
    fieldConfig: {
      defaults: { unit: 'none', color: { mode: 'thresholds' }, thresholds: th([C.neutral, null]), mappings: [] },
      overrides: items.map((it, i) => forRef(i, [
        { id: 'displayName', value: it.name },
        { id: 'unit', value: it.unit || 'none' },
        { id: 'thresholds', value: it.thresholds || th([C.neutral, null]) },
        { id: 'mappings', value: [...(it.mappings || []), noData(it.noValue || 'NO DATA')] },
        ...(it.decimals !== undefined ? [{ id: 'decimals', value: it.decimals }] : []),
        { id: 'noValue', value: it.noValue || 'NO DATA' },
      ])),
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'value', graphMode: 'none', textMode: 'value_and_name',
      justifyMode: 'center', orientation: 'vertical', wideLayout: true, showPercentChange: false, text: { titleSize, valueSize },
    },
  });
}
// Labels shown as small coloured chips (versions, data centres).
function chips(title, description, target, gridPos, color = C.green, transformations = []) {
  return push({
    type: 'stat', title, description, gridPos, transparent: true, datasource: target.datasource, transformations,
    targets: refs([instant(target)]),
    fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: color }, thresholds: th([color, null]), noValue: 'NO DATA' }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'background', graphMode: 'none', textMode: 'name',
      justifyMode: 'center', orientation: 'vertical', wideLayout: true, showPercentChange: false, text: { titleSize: 12, valueSize: 15 } },
  });
}
// Smooth area chart with a subtle gradient; per-query tweaks through `per` (refId index -> properties).
function area(title, description, targets, gridPos, o = {}) {
  const { unit = 'short', stack = false, min = 0, max, softMax, decimals, fill = 14, legend = 'list', calcs = [], overrides = [], thresholdLine, names, per = {}, interval, log, draw = 'line' } = o;
  return push({
    type: 'timeseries', title, description, gridPos, datasource: new Set(targets.map(t => t.datasource.uid)).size > 1 ? MIXED : targets[0].datasource,
    ...(interval ? { interval } : {}),
    targets: refs(targets.map(ranged)),
    fieldConfig: {
      defaults: {
        unit, min: log ? undefined : min, max, decimals, color: { mode: 'palette-classic' },
        thresholds: thresholdLine ? th(['transparent', null], [thresholdLine[1], thresholdLine[0]]) : th(['green', null]),
        custom: {
          drawStyle: draw, lineInterpolation: 'smooth', lineWidth: 1.5, fillOpacity: fill, gradientMode: 'opacity', showPoints: 'never', barAlignment: 0,
          spanNulls: false, insertNulls: false, axisBorderShow: false, axisPlacement: 'auto', axisSoftMax: softMax, axisGridShow: true,
          scaleDistribution: log ? { type: 'log', log: 10 } : { type: 'linear' },
          stacking: { mode: stack ? 'normal' : 'none', group: 'A' }, thresholdsStyle: { mode: thresholdLine ? 'dashed' : 'off' },
        },
      },
      overrides: [...overrides, ...byRef(names), ...Object.entries(per).map(([i, props]) => forRef(+i, props))],
    },
    options: { legend: { displayMode: legend, placement: 'bottom', showLegend: true, calcs }, tooltip: { mode: 'multi', sort: 'desc' } },
  });
}
// Status line per series over time (state timeline).
function timeline(title, description, targets, gridPos, mappings, { noValue, thresholds = th([C.red, null], [C.green, 1]) } = {}) {
  return push({
    type: 'state-timeline', title, description, gridPos, datasource: targets[0].datasource,
    targets: refs(targets.map(ranged)),
    fieldConfig: { defaults: { mappings, thresholds, noValue, color: { mode: 'thresholds' }, custom: { fillOpacity: 75, lineWidth: 0 } }, overrides: [] },
    options: { showValue: 'never', rowHeight: 0.75, mergeValues: true, alignValue: 'center', legend: { showLegend: false }, tooltip: { mode: 'single' } },
  });
}
// Grid of cells per series over time (status history); each cell shows the worst state inside it.
function history(title, description, target, gridPos, mappings, interval) {
  return push({
    type: 'status-history', title, description, gridPos, datasource: target.datasource, interval, maxDataPoints: 96,
    targets: refs([ranged(target)]),
    fieldConfig: { defaults: { mappings, thresholds: SVC_TH, color: { mode: 'thresholds' }, custom: { fillOpacity: 80, lineWidth: 1 } }, overrides: [] },
    options: { showValue: 'never', rowHeight: 0.85, colWidth: 0.92, legend: { showLegend: false }, tooltip: { mode: 'single' } },
  });
}
// Horizontal bar chart for a top-N Loki instant query (Grafana turns it into ONE table: a row per label value
// and the count in "Value #A").
function barchart(title, description, expr, label, header, gridPos, color) {
  return push({
    type: 'barchart', title, description, gridPos, datasource: LOKI,
    targets: refs([instant(loki(expr, `{{${label}}}`))]),
    transformations: [
      { id: 'organize', options: { excludeByName: { Time: true }, renameByName: { [label]: header, 'Value #A': 'Requests' } } },
      { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Requests', desc: true }] } },
    ],
    fieldConfig: {
      defaults: { color: { mode: 'fixed', fixedColor: color }, min: 0, decimals: 0, noValue: 'No requests in this period',
        custom: { fillOpacity: 75, gradientMode: 'none', lineWidth: 0, axisBorderShow: false, axisGridShow: false } },
      overrides: [],
    },
    options: { orientation: 'horizontal', xField: header, showValue: 'always', barWidth: 0.45, groupWidth: 0.7, barRadius: 0.2, stacking: 'none',
      xTickLabelRotation: 0, xTickLabelMaxLength: 42, fullHighlight: false, legend: { showLegend: false, displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'single' } },
  });
}
// Donut of ONE Loki instant query grouped by a label: rowsToFields turns each row into a named field, so
// every slice keeps a fixed colour per name.
function donut(title, description, expr, label, gridPos, colors) {
  return push({
    type: 'piechart', title, description, gridPos, datasource: LOKI, transparent: true,
    targets: refs([instant(loki(expr, `{{${label}}}`))]),
    transformations: [
      { id: 'organize', options: { excludeByName: { Time: true } } },
      { id: 'rowsToFields', options: { mappings: [{ fieldName: label, handlerKey: 'field.name' }, { fieldName: 'Value #A', handlerKey: 'field.value' }] } },
    ],
    fieldConfig: { defaults: { unit: 'short', decimals: 0, color: { mode: 'palette-classic' }, noValue: 'No requests in this period' }, overrides: byName(colors) },
    options: {
      pieType: 'donut', displayLabels: ['percent'], reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      legend: { displayMode: 'table', placement: 'right', showLegend: true, values: ['value', 'percent'] }, tooltip: { mode: 'single' },
    },
  });
}
// Ranking table for a Loki instant query grouped by several labels.
function rankTable(title, description, expr, columns, gridPos, noValue) {
  const order = Object.fromEntries([...Object.keys(columns), 'Value #A'].map((k, i) => [k, i]));
  return push({
    type: 'table', title, description, gridPos, datasource: LOKI,
    targets: refs([instant(loki(expr))]),
    transformations: [
      { id: 'organize', options: { excludeByName: { Time: true }, indexByName: order, renameByName: { ...columns, 'Value #A': 'Requests' } } },
      { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Requests', desc: true }] } },
    ],
    fieldConfig: {
      defaults: { noValue, custom: { align: 'auto', cellOptions: { type: 'auto' }, inspect: true } },
      overrides: [['Requests', 90], ['Method', 80], ['Status', 70]].map(([n, w]) => ({ matcher: { id: 'byName', options: n }, properties: [{ id: 'custom.width', value: w }, { id: 'decimals', value: 0 }] })),
    },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
  });
}
// Grafana's native alert list (reads the Prometheus rules through the data source).
function alertList(title, description, gridPos) {
  return push({
    type: 'alertlist', title, description, gridPos,
    options: { viewMode: 'list', groupMode: 'default', groupBy: [], maxItems: 20, sortOrder: 1, dashboardAlerts: false, alertName: '', alertInstanceLabelFilter: '',
      showInstances: false, stateFilter: { firing: true, pending: true, noData: false, normal: false, error: true, recovering: true } },
  });
}
function logs(title, description, expr, gridPos) {
  return push({
    type: 'logs', title, description, gridPos, datasource: LOKI,
    targets: refs([{ datasource: LOKI, expr, queryType: 'range' }]),
    options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true, dedupStrategy: 'none', prettifyLogMessage: false, showCommonLabels: false, showLabels: false },
  });
}

// ---------------------------------------------------------------- shared PromQL pieces
const PUBLIC = 'job="blackbox_public"';
const HOME = 'instance="https://gfilho.net/"';
const ORIGIN = 'job="blackbox_origin", instance="http://127.0.0.1:8088/"';
const SVCS = 'nginx.service|cloudflared.service|docker.service|gfilho-metrics.timer';
const NET = 'device=~"eth[0-9]+"';                        // physical (mirrored) interfaces only; loopback0 carries localhost traffic
// probe result per target, or 0.5 (UNKNOWN) for a target Prometheus cannot scrape; min() lets DOWN win over UNKNOWN
const probeState = sel => `min(probe_success{${sel}} or up{${sel}} * 0 + 0.5)`;
// systemd: 1 running, 0 stopped (inactive, activating), -1 failed
const unitState = name => `sum(node_systemd_unit_state{name="${name}", state="active"}) - sum(node_systemd_unit_state{name="${name}", state="failed"})`;
// used share of a filesystem the way df computes it (root-reserved blocks are not free for normal use)
const dfUsed = mp => `(node_filesystem_size_bytes{mountpoint="${mp}"} - node_filesystem_free_bytes{mountpoint="${mp}"}) / (node_filesystem_size_bytes{mountpoint="${mp}"} - node_filesystem_free_bytes{mountpoint="${mp}"} + node_filesystem_avail_bytes{mountpoint="${mp}"})`;

// ---------------------------------------------------------------- shared LogQL pieces
// Visitor traffic = the production access log (staging only gets local previews) without the monitoring probes,
// automated tools (curl, scripts, headless browsers, the self-audit link checker) and local previews.
const PROD = '{job="nginx", log="access", env="production"}';
const NOISE = 'gfilho-monitor|curl/|ython-urllib|HeadlessChrome|Chrome-Lighthouse|self-audit';    // literal alternatives: Loki matches them without a regex engine
const ACC = `${PROD} !~ "${NOISE}"`;
const PAT = '| pattern `<_> - <_> [<_>] "<method> <path> <_>" <status> <bytes> "<referer>" "<agent>"<_>`';
const LOCAL = '| referer !~ `https?://(localhost|127\\.0\\.0\\.1)([:/].*)?`';            // local previews are not visitors
const NORM = '| label_format page=`{{ regexReplaceAll "\\\\?.*$" .path "" }}`';             // page = path without ?query (/?utm=x counts as /). A new label on purpose: later filters ignore an overwritten "path"
const base = (lineFilter = '') => `${ACC} ${lineFilter ? lineFilter + ' ' : ''}${PAT} ${LOCAL} ${NORM}`;
const BASE = base();
const IS404 = '|= "\\" 404 "';                     // cheap literal filter before parsing: the status follows the quoted request line
const CLASS = '| label_format class=`{{ substr 0 1 .status }}xx`';
const ASSET = '| page !~ `^/(assets|cdn-cgi)/.*` | page !~ `.*\\.(png|ico|svg|xml|txt|webmanifest|jpg|woff2|js|css|map)$`';
const PAGE = '| page =~ `^/(cases/[a-z0-9-]+/)?$`';
const VIEW = '| status=~"200|304"';
const UNUSUAL = '| (status=~"4.." and status!="404") or status=~"5.." or method!~"GET|HEAD"';
// Client classes from the User-Agent, mutually exclusive by construction (first match wins):
//   Bots & tools  declared bots, crawlers, scanners, link previews, HTTP libraries, any UA with a URL in it
//   Browsers      what a real browser sends (platform token + engine); scanners can fake it: an upper bound for people
//   Unclassified  everything else (empty, "-", custom strings)
const BOT_RE = '(?i)(bot|crawl|spider|slurp|scan|preview|feed|monitor|checker|validator|measurement|dataprovider|heritrix|archiver|python|go-http|wget|curl|okhttp|java/|libwww|httpx|aiohttp|axios|node-fetch|undici|^node$|headless|phantom|https?://)';
const BROWSER_RE = '^Mozilla/5[.]0 [(](Windows|Macintosh|X11|Linux|iPhone|iPad|Android)[^)]*[)].*(Chrome|Firefox|Safari|Edg|OPR)/[0-9]';
const CLIENT = '| label_format client=`{{ if gt (count "' + BOT_RE + '" .agent) 0 }}Bots & tools{{ else if gt (count "' + BROWSER_RE + '" .agent) 0 }}Browsers{{ else }}Unclassified{{ end }}`';
// Every access-log line of both servers in exactly one source (the order of the tests matters)
const SOURCE = '| label_format source=`{{ if eq .env "staging" }}Staging{{ else if contains "gfilho-monitor" .agent }}Monitoring probes{{ else if gt (__line__ | count "' + NOISE + '") 0 }}Automated tools{{ else if gt (count "^https?://(localhost|127[.]0[.]0[.]1)([:/].*)?$" .referer) 0 }}Local previews{{ else }}Visitors{{ end }}`';
const KIND = '| label_format kind=`{{ if eq .status "404" }}404 not found{{ else if hasPrefix "5" .status }}5xx server error{{ else }}Other 4xx{{ end }}`';

// ---------------------------------------------------------------- annotations and links
const ANN = {
  builtin: { builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' },
  deploys: { datasource: PROM, enable: true, iconColor: C.blue, name: 'Deploys', expr: 'changes(gfilho_last_deploy_timestamp_seconds{target="production"}[3m]) > 0', step: '1m', titleFormat: 'Deploy to production', textFormat: 'deploy.sh production' },
  // the 10 minutes after each boot (Prometheus has no samples from before the boot, so changes() would never see it)
  wsl: { datasource: PROM, enable: true, iconColor: C.amber, name: 'WSL starts', expr: 'time() - node_boot_time_seconds < 600', step: '1m', titleFormat: 'WSL started', textFormat: 'WSL was not running before this point: the site was offline' },
  tunnel: { datasource: PROM, enable: true, iconColor: C.teal, name: 'Tunnel registrations', expr: 'changes(cloudflared_tunnel_tunnel_register_success[2m]) > 0', step: '1m', titleFormat: 'Tunnel connection registered', textFormat: 'cloudflared (re)connected to the Cloudflare edge' },
};
const LINKS = [
  { title: 'Alert rules', url: '/alerting/list', type: 'link', targetBlank: false, icon: 'bolt', keepTime: false },
  { title: 'Live site', url: 'https://gfilho.net/', type: 'link', targetBlank: true, icon: 'external link' },
  { title: 'Runbook (README → Monitoring)', url: 'https://github.com/biazini/gfilho-website#9-monitoring', type: 'link', targetBlank: true, icon: 'doc' },
];

// ---------------------------------------------------------------- dashboard assembly and checks
const KNOWN_TYPES = new Set(['alertlist', 'barchart', 'logs', 'piechart', 'row', 'stat', 'state-timeline', 'status-history', 'table', 'timeseries']);   // all installed in Grafana 13.0.2 (/api/frontend/settings)
const dashboards = [];
function finish(file, meta) {
  const d = {
    uid: meta.uid, title: meta.title, description: meta.description, tags: ['gfilho.net', 'website'], timezone: 'browser', editable: false, graphTooltip: 1,
    schemaVersion: 42, version: 4, time: { from: 'now-24h', to: 'now' }, refresh: meta.refresh, fiscalYearStartMonth: 0, liveNow: false, weekStart: '',
    timepicker: { refresh_intervals: ['1m', '5m', '15m', '30m', '1h'] }, templating: { list: [] },
    annotations: { list: [ANN.builtin, ...meta.annotations] }, links: LINKS, panels: B.top,
  };
  dashboards.push([file, d]);
}
function validate([file, d], titles) {
  const fail = msg => { throw new Error(`${file}: ${msg}`); };
  const all = d.panels.flatMap(p => [p, ...(p.panels || [])]);
  const ids = all.map(p => p.id);
  if (new Set(ids).size !== ids.length) fail('duplicate panel ids');
  for (const p of all) {
    if (!KNOWN_TYPES.has(p.type)) fail(`unknown panel type ${p.type}`);
    const { x, y, w, h } = p.gridPos;
    if (x < 0 || w < 1 || x + w > 24 || y < 0 || h < 1) fail(`"${p.title}" is off the 24-column grid`);
    for (const t of p.targets || []) if (!['prometheus', 'loki'].includes(t.datasource.uid)) fail(`"${p.title}" ${t.refId}: unknown data source`);
    if (p.type !== 'row') {
      if (titles.has(p.title)) fail(`panel title "${p.title}" is used twice (the checkers find panels by title)`);
      titles.add(p.title);
    }
    for (const l of p.links || []) if (/localhost|127\.0\.0\.1/.test(l.url)) fail(`"${p.title}" links to localhost`);
  }
  for (const l of d.links) if (/localhost|127\.0\.0\.1/.test(l.url || '')) fail(`dashboard link "${l.title}" points to localhost`);
  // overlaps: the visible grid, and the inside of each collapsed row (laid out as if it were expanded)
  const groups = [d.panels, ...d.panels.filter(p => p.collapsed).map(p => p.panels)];
  for (const g of groups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const a = g[i].gridPos, b = g[j].gridPos;
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) fail(`"${g[i].title}" overlaps "${g[j].title}"`);
  }
}

// Cloudflare names its data centres after the nearest airport (IATA code): show the city instead.
const CITIES = { lis: 'Lisbon', opo: 'Porto', mad: 'Madrid', bcn: 'Barcelona', ams: 'Amsterdam', fra: 'Frankfurt', cdg: 'Paris', mrs: 'Marseille',
  lhr: 'London', man: 'Manchester', dub: 'Dublin', bru: 'Brussels', dus: 'Düsseldorf', ham: 'Hamburg', muc: 'Munich', mxp: 'Milan', fco: 'Rome', zrh: 'Zurich',
  gva: 'Geneva', vie: 'Vienna', prg: 'Prague', waw: 'Warsaw', cph: 'Copenhagen', arn: 'Stockholm', osl: 'Oslo', hel: 'Helsinki', ath: 'Athens', iad: 'Ashburn', ewr: 'Newark', gru: 'São Paulo' };
const EDGE_NAMES = Object.entries(CITIES).map(([code, city]) => ({ id: 'renameByRegex', options: {
  regex: '^Connection (\\d+) · ' + code + '(\\d+)$', renamePattern: 'Connection $1 → ' + city + ' (' + code.toUpperCase() + '$2)' } }));
const ALERT_STATE = map([[1, 'Pending', C.amber], [2, 'Firing', C.red]]);

// ================================================================ status (top, no row: always open)
board();
strip('Status', 'Is the site reachable right now? Public site = all public pages pass from the internet (DNS → Cloudflare → tunnel → nginx); Origin = nginx answered directly. Public DOWN with Origin UP points at Cloudflare or the tunnel; both DOWN at nginx or WSL. UNKNOWN = Prometheus cannot reach the probe exporter. Response time colours follow the web.dev TTFB guidance (0.8 s / 1.8 s). p95, Availability and Monitored cover the selected range; Availability counts only the time monitoring was running, and Monitored says how much of the range that was (below 100 % = WSL or the stack was off). The probes run from this PC, so a local network fault looks like an outage: pair this with an external uptime monitor (README → Monitoring).', [
  { name: 'Public site', q: prom(probeState(PUBLIC)), mappings: PROBE, thresholds: PROBE_TH },
  { name: 'Origin', q: prom(probeState(ORIGIN)), mappings: PROBE, thresholds: PROBE_TH },
  { name: 'Tunnel links', q: prom('cloudflared_tunnel_ha_connections or up{job="cloudflared"} * 0'), thresholds: th([C.red, null], [C.amber, 1], [C.green, 4]) },
  { name: 'Response time', q: prom(`max(probe_duration_seconds{${PUBLIC}, ${HOME}})`), unit: 's', thresholds: LATENCY },
  { name: 'p95 (range)', q: prom(`max(quantile_over_time(0.95, probe_duration_seconds{${PUBLIC}, ${HOME}}[$__range]))`), unit: 's', thresholds: LATENCY },
  { name: 'Availability', q: prom(`sum(sum_over_time(probe_success{${PUBLIC}, ${HOME}}[$__range])) / sum(count_over_time(probe_success{${PUBLIC}, ${HOME}}[$__range]))`), unit: 'percentunit', decimals: 2, thresholds: th([C.amber, null], [C.green, 0.99999]) },
  { name: 'Monitored', q: prom(`clamp_max(sum(count_over_time(probe_success{${PUBLIC}, ${HOME}}[$__range])) / ($__range_s / 60), 1)`), unit: 'percentunit', decimals: 1, thresholds: th([C.amber, null], [C.green, 0.995]) },
  { name: 'Alerts firing', q: prom('count(ALERTS{alertstate="firing"}) or vector(0)'), thresholds: ZERO_OK },
], pos(0, 0, 24, 4), { valueSize: 30 });
strip('Lifecycle', 'Time left until the TLS certificate (earliest expiry among every HTTPS address probed; Cloudflare renews it) and /.well-known/security.txt expire (renew it before 30 days: the SecurityTxtExpiringSoon alert fires then). WSL offline = time WSL was not running, from the systemd journal: the site was down then.', [
  { name: 'TLS certificate expires in', q: prom('min(probe_ssl_earliest_cert_expiry{job=~"blackbox_public|blackbox_redirects"}) - time()'), unit: 'dtdurations', thresholds: th([C.red, null], [C.amber, 14 * DAY], [C.green, 30 * DAY]) },
  { name: 'security.txt expires in', q: prom('gfilho_security_txt_expires_timestamp_seconds - time()'), unit: 'dtdurations', thresholds: th([C.red, null], [C.amber, 30 * DAY], [C.green, 60 * DAY]) },
  { name: 'Last deploy', q: prom('time() - gfilho_last_deploy_timestamp_seconds{target="production"}'), unit: 'dtdurations' },
  { name: 'WSL offline · 24 h', q: prom('gfilho_wsl_offline_seconds{window="24h"}'), unit: 'dtdurations', thresholds: th([C.green, null], [C.amber, 60]) },
  { name: 'WSL offline · 7 d', q: prom('gfilho_wsl_offline_seconds{window="7d"}'), unit: 'dtdurations', thresholds: th([C.green, null], [C.amber, 60]) },
], pos(0, 4, 24, 3), { valueSize: 17, titleSize: 11 });
timeline('Uptime', 'Every check as one status line. Green = OK, red = failing, blank = no data (WSL or the monitoring stack was not running). Public pages every 60 s, origin and staging every 30 s, 301 redirects and DNS every 5 min.',
  [prom('probe_success{check!=""}', '{{check}}')], pos(0, 7, 24, 7), OKFAIL).transparent = true;
alertList('Alerts now', 'Firing and pending Prometheus alerts (monitoring/prometheus/rules.yml). There is no Alertmanager: nothing is sent anywhere, this list is the notification.', pos(0, 14, 8, 7));
timeline('Alert history', 'When each alert was pending (amber: the condition is true but its "for" time has not passed yet) or firing (red) in the selected range, one line per alert.',
  [prom('max by (alertname, severity) (ALERTS{alertstate="firing"}) * 2 or max by (alertname, severity) (ALERTS{alertstate="pending"})', '{{alertname}} · {{severity}}')], pos(8, 14, 16, 7), ALERT_STATE,
  { noValue: 'No alerts in this period', thresholds: th([C.amber, null], [C.red, 2]) });
row('Latency & traffic', 21);
area('Public response time', 'Total time of each probe: the public pages through Cloudflare and the tunnel, and nginx answered directly (origin). Logarithmic axis, so both are readable; dashed line = 0.8 s (web.dev "good" TTFB). These are synthetic probes from this PC, not the latency of real visitors.',
  [prom('max by (check) (probe_duration_seconds{job=~"blackbox_public|blackbox_origin", check!=""})', '{{check}}')], pos(0, 22, 12, 8), { unit: 's', fill: 6, log: true, thresholdLine: [0.8, C.amber] });
area('Traffic through the tunnel', 'Every request that reached the site from the internet (visitors, bots and the public probes) by HTTP status class, from cloudflared, plus requests cloudflared could not deliver to nginx (red, should stay at 0). Visitors only: the Visitors & security section below.',
  [prom('sum by (class) (label_replace(rate(cloudflared_tunnel_response_by_code[$__rate_interval]), "class", "${1}xx", "status_code", "(.)..")) * 3600', '{{class}}'),
   prom('(rate(cloudflared_tunnel_request_errors[$__rate_interval]) + rate(cloudflared_proxy_connect_streams_errors[$__rate_interval])) * 3600')], pos(12, 22, 12, 8),
  { unit: REQH, stack: true, fill: 22, overrides: byName(STATUS_COLORS), per: {
    1: [{ id: 'displayName', value: 'Proxy errors' }, { id: 'custom.stacking', value: { mode: 'none', group: 'errors' } }, { id: 'custom.fillOpacity', value: 0 }, { id: 'color', value: { mode: 'fixed', fixedColor: C.red } }],
  } });

// ================================================================ visitors & security (production access log)
below();
row('Visitors & security', 0);
below();
strip('Visitor traffic', 'Totals for the selected range, from the production access log, without the monitoring probes, automated tools and local previews (see Request sources). Requests count every response (pages, files, errors); Page views only pages answered 200 or 304. Data served = response bodies of all visitor requests (headers excluded). These are requests, not people: unique visitors cannot be counted reliably (and are not tracked). Log pipeline = probe lines received by Loki in the last 5 minutes; when it says NO LOGS the zeros here mean nothing.', [
  { name: 'Page views', q: loki(`sum(count_over_time(${BASE} ${VIEW} ${PAGE} [$__range])) or vector(0)`) },
  { name: 'Requests', q: loki(`sum(count_over_time(${BASE} [$__range])) or vector(0)`) },
  { name: 'Data served', q: loki(`sum(sum_over_time(${BASE} | unwrap bytes | __error__="" [$__range])) or vector(0)`), unit: 'decbytes' },
  { name: '404 responses', q: loki(`sum(count_over_time(${base(IS404)} | status="404" [$__range])) or vector(0)`) },
  { name: '5xx responses', q: loki(`sum(count_over_time(${BASE} | status=~"5.." [$__range])) or vector(0)`), thresholds: ZERO_OK },
  { name: '5xx share', q: loki(`((sum(count_over_time(${BASE} | status=~"5.." [$__range])) or vector(0)) / sum(count_over_time(${BASE} [$__range]))) or vector(0)`), unit: 'percentunit', decimals: 2, thresholds: th([C.green, null], [C.red, 1e-9]) },
  { name: 'Log pipeline', q: loki(`sum(count_over_time(${PROD} |= "gfilho-monitor" [5m])) or vector(0)`), thresholds: th([C.red, null], [C.green, 1]),
    mappings: [{ type: 'value', options: { 0: { text: 'NO LOGS', color: C.red, index: 0 } } }, { type: 'range', options: { from: 1, to: 1e12, result: { text: 'OK', color: C.green, index: 1 } } }] },
], pos(0, 0, 24, 4), { valueSize: 28 });
area('Request sources', 'Every line of both access logs in exactly one group (stacked), as requests per hour: visitors, monitoring probes, automated tools (curl, scripts, headless browsers, link checkers), local previews and staging. Dashed: the total nginx counted (stub_status), which also includes the exporter\'s own status requests. Only "Visitors" feeds the other figures of this section.',
  [loki(`sum by (source) (rate({job="nginx", log="access"} ${PAT} ${SOURCE} [$__auto])) * 3600`, '{{source}}'), prom('rate(nginx_http_requests_total[$__rate_interval]) * 3600')], pos(0, 4, 12, 8),
  { unit: REQH, stack: true, fill: 26, interval: '15m', overrides: byName({ Visitors: C.green, 'Monitoring probes': C.grey, 'Automated tools': C.purple, 'Local previews': C.teal, Staging: C.blue }), per: {
    1: [{ id: 'displayName', value: 'nginx total (stub_status)' }, { id: 'custom.stacking', value: { mode: 'none', group: 'total' } }, { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineStyle', value: { fill: 'dash', dash: [6, 4] } }, { id: 'color', value: { mode: 'fixed', fixedColor: C.neutral } }],
  } });
area('Visitor responses by status class', 'Visitor requests per hour by HTTP status class (15-minute buckets). 4xx spikes are usually bots probing for files that do not exist (see Top 404s).',
  [loki(`sum by (class) (rate(${BASE} ${CLASS} [$__auto])) * 3600`, '{{class}}')], pos(12, 4, 12, 8), { unit: REQH, stack: true, fill: 30, interval: '15m', overrides: byName(STATUS_COLORS) });
area('Error share', 'Share of visitor requests in the previous hour that ended in 404, another 4xx or a 5xx (rolling 1-hour window). A static site should never answer 5xx; 404s are mostly scanners.',
  [loki(`sum by (kind) (count_over_time(${BASE} | status=~"4..|5.." ${KIND} [1h])) / ignoring(kind) group_left sum(count_over_time(${BASE} [1h]))`, '{{kind}}')], pos(0, 12, 12, 8),
  { unit: 'percentunit', max: 1, fill: 10, interval: '15m', overrides: byName({ '404 not found': C.amber, 'Other 4xx': C.purple, '5xx server error': C.red }) });
area('Data served', 'Response-body bytes per second sent to visitors: pages, files and error pages (headers excluded), 15-minute buckets. Same scope as Requests, so it is not limited to page views.',
  [loki(`sum(rate(${BASE} | unwrap bytes | __error__="" [$__auto]))`, 'Bytes')], pos(12, 12, 12, 8), { unit: 'Bps', fill: 24, interval: '15m' });
barchart('Top pages', 'The 10 most requested paths answered 200 or 304, without CSS, JS, images and technical files (query strings removed).',
  `topk(10, sum by (page) (count_over_time(${BASE} ${VIEW} ${ASSET} [$__range])))`, 'page', 'Page', pos(0, 20, 8, 9), C.green);
barchart('Top 404s', 'Requested paths that do not exist (query strings removed). Mostly bots looking for WordPress, .env files and similar: harmless here, none of it exists.',
  `topk(10, sum by (page) (count_over_time(${base(IS404)} | status="404" [$__range])))`, 'page', 'Path', pos(8, 20, 8, 9), C.amber);
barchart('Top referrers', 'Where page views came from (links from the site itself are left out).',
  `topk(10, sum by (referer) (count_over_time(${BASE} ${VIEW} ${PAGE} | referer != "-" | referer !~ \`https?://(www\\.)?gfilho\\.net.*\` [$__range])))`, 'referer', 'Referrer', pos(16, 20, 8, 9), C.purple);
donut('Clients', 'Page views by client type, a heuristic on the User-Agent with three exclusive groups. Bots & tools: declared bots, crawlers, scanners, link previews, HTTP libraries and any User-Agent with a URL in it. Browsers: looks like a real browser (scanners can fake this, so it is an upper bound for people). Unclassified: anything else.',
  `sum by (client) (count_over_time(${BASE} ${VIEW} ${PAGE} ${CLIENT} [$__range]))`, 'client', pos(0, 29, 6, 8), { Browsers: C.blue, 'Bots & tools': C.grey, Unclassified: C.purple });
donut('Status mix', 'All visitor requests in the selected range by status class (same colours as above).',
  `sum by (class) (count_over_time(${BASE} ${CLASS} [$__range]))`, 'class', pos(6, 29, 6, 8), STATUS_COLORS);
rankTable('Unusual requests', 'Visitor requests worth a look: methods other than GET and HEAD, 5xx, and 4xx other than 404 (404s are in Top 404s). The path is shown exactly as requested, query string included. Open "Logs → Unusual requests · raw lines" for the full lines.',
  `topk(15, sum by (method, status, path) (count_over_time(${BASE} ${UNUSUAL} [$__range])))`, { method: 'Method', status: 'Status', path: 'Path (as requested)' }, pos(12, 29, 12, 8), 'Nothing unusual in this period');

// ================================================================ infrastructure: services, tunnel, web server, host, publishing
below();
row('Services', 0);
strip('Services now', 'systemd state of the hosting services (RUNNING, STOPPED or FAILED; NO DATA = node-exporter is not answering), units in a failed state, times systemd restarted nginx or cloudflared after a crash (Restart=on-failure) since WSL started, and how long WSL has been running.', [
  { name: 'nginx', q: prom(unitState('nginx.service')), mappings: SVC, thresholds: SVC_TH },
  { name: 'cloudflared', q: prom(unitState('cloudflared.service')), mappings: SVC, thresholds: SVC_TH },
  { name: 'Docker', q: prom(unitState('docker.service')), mappings: SVC, thresholds: SVC_TH },
  { name: 'Metrics timer', q: prom(unitState('gfilho-metrics.timer')), mappings: SVC, thresholds: SVC_TH },
  { name: 'Failed units', q: prom('sum(node_systemd_unit_state{state="failed"})'), thresholds: ZERO_OK },
  { name: 'nginx restarts', q: prom('node_systemd_service_restart_total{name="nginx.service"}'), thresholds: th([C.green, null], [C.amber, 1]) },
  { name: 'cloudflared restarts', q: prom('node_systemd_service_restart_total{name="cloudflared.service"}'), thresholds: th([C.green, null], [C.amber, 1]) },
  { name: 'WSL running for', q: prom('time() - node_boot_time_seconds'), unit: 'dtdurations' },
], pos(0, 1, 24, 4), { valueSize: 26 });
history('Service history', 'State of each hosting service over time, one cell per interval. A cell shows the worst state inside it, so a short outage between two samples is not hidden. Blank = no data.',
  prom(`min by (name) (min_over_time(node_systemd_unit_state{state="active", name=~"${SVCS}"}[$__interval])) - max by (name) (max_over_time(node_systemd_unit_state{state="failed", name=~"${SVCS}"}[$__interval]))`, '{{name}}'), pos(0, 5, 24, 5), SVC, '5m');
row('Cloudflare Tunnel', 10);
strip('Tunnel now', 'Active connections to the Cloudflare edge (cloudflared keeps 4; 0 = the site is unreachable), their average smoothed QUIC round-trip time, connections registered in the selected range (4 at every cloudflared start, then one per reconnect) and requests or streams cloudflared could not deliver to nginx.', [
  { name: 'Links', q: prom('cloudflared_tunnel_ha_connections or up{job="cloudflared"} * 0'), thresholds: th([C.red, null], [C.amber, 1], [C.green, 4]) },
  { name: 'Edge RTT', q: prom('avg(quic_client_smoothed_rtt)'), unit: 'ms', decimals: 0 },
  { name: 'Registrations (range)', q: prom('round(sum(increase(cloudflared_tunnel_tunnel_register_success[$__range])))') },
  { name: 'Proxy errors (range)', q: prom('round(sum(increase(cloudflared_tunnel_request_errors[$__range])) + sum(increase(cloudflared_proxy_connect_streams_errors[$__range])))'), thresholds: ZERO_OK },
], pos(0, 11, 12, 4), { valueSize: 26 });
chips('Connected data centres', 'The Cloudflare data centre each of the 4 tunnel connections is attached to (named after the nearest airport: LIS = Lisbon, AMS = Amsterdam). Visitors reach the site through any of them; if one drops, the others keep it online.',
  prom('cloudflared_tunnel_server_locations', 'Connection {{connection_id}} · {{edge_location}}'), pos(12, 11, 12, 4), C.teal, EDGE_NAMES);
area('Tunnel responses by status code', 'HTTP status codes nginx returned through the tunnel, in requests per hour (areas, stacked), and requests or streams cloudflared could not deliver (red lines, should stay at 0).',
  [prom('sum by (status_code) (rate(cloudflared_tunnel_response_by_code[$__rate_interval])) * 3600', '{{status_code}}'),
   prom('rate(cloudflared_tunnel_request_errors[$__rate_interval]) * 3600'), prom('rate(cloudflared_proxy_connect_streams_errors[$__rate_interval]) * 3600')], pos(0, 15, 12, 8),
  { unit: REQH, stack: true, fill: 22, overrides: CODE_COLORS, per: {
    1: [{ id: 'displayName', value: 'Request errors' }, { id: 'custom.stacking', value: { mode: 'none', group: 'errors' } }, { id: 'custom.fillOpacity', value: 0 }, { id: 'color', value: { mode: 'fixed', fixedColor: C.red } }],
    2: [{ id: 'displayName', value: 'Stream errors' }, { id: 'custom.stacking', value: { mode: 'none', group: 'errors' } }, { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineStyle', value: { fill: 'dash', dash: [6, 4] } }, { id: 'color', value: { mode: 'fixed', fixedColor: C.red } }],
  } });
area('Edge link', 'Active tunnel connections (left axis, normal 4: dashed line) and the smoothed QUIC round-trip time of each connection (right axis, milliseconds as cloudflared reports it). Reconnections are marked by the "Tunnel registrations" annotation.',
  [prom('cloudflared_tunnel_ha_connections'), prom('quic_client_smoothed_rtt', 'RTT · connection {{conn_index}}')], pos(12, 15, 12, 8),
  { decimals: 0, fill: 6, thresholdLine: [4, C.green], per: {
    0: [{ id: 'displayName', value: 'Active connections' }, { id: 'color', value: { mode: 'fixed', fixedColor: C.green } }, { id: 'custom.fillOpacity', value: 16 }],
    1: [{ id: 'unit', value: 'ms' }, { id: 'custom.axisPlacement', value: 'right' }, { id: 'custom.axisLabel', value: 'RTT' }, { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineWidth', value: 1 }],
  } });
row('Web server & probes', 23);
area('Request rate · nginx vs tunnel', 'Requests per hour counted by nginx on all its servers (production, staging, the monitoring probes and the exporter\'s own status requests) and by cloudflared (everything that came in from the internet). The visitor share is in the Visitors & security section.',
  [prom('rate(nginx_http_requests_total[$__rate_interval]) * 3600'), prom('rate(cloudflared_tunnel_total_requests[$__rate_interval]) * 3600')], pos(0, 24, 8, 8),
  { unit: REQH, names: ['nginx · all servers', 'Tunnel · from the internet'], legend: 'table', calcs: ['mean', 'max'] });
area('nginx connections', 'Open client connections in nginx (stub_status): reading the request, writing the response, idle keep-alive.',
  [prom('nginx_connections_active'), prom('nginx_connections_reading'), prom('nginx_connections_writing'), prom('nginx_connections_waiting')], pos(8, 24, 8, 8),
  { names: ['Active', 'Reading', 'Writing', 'Idle (keep-alive)'], decimals: 0 });
area('Response time by phase', 'Where the time of the probe to https://gfilho.net/ goes (stacked; the total is the probe time): DNS, connect, TLS, processing (Cloudflare edge → tunnel → nginx until the first byte) and transfer.',
  [prom(`max by (phase) (probe_http_duration_seconds{${PUBLIC}, ${HOME}})`, '{{phase}}')], pos(16, 24, 8, 8), { unit: 's', stack: true, fill: 22 });
row('Host · WSL', 32);
area('CPU & memory', 'Busy CPU (everything but idle) and memory in use (total minus available) of the WSL VM, which the Ascender lab shares.',
  [prom('1 - avg(rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval]))', 'CPU'), prom('1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes', 'Memory')], pos(0, 33, 8, 8),
  { unit: 'percentunit', max: 1 });
area('Memory', 'Used and available memory in the WSL VM (stacked: the top is the total).',
  [prom('node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes'), prom('node_memory_MemAvailable_bytes')], pos(8, 33, 8, 8),
  { unit: 'bytes', stack: true, fill: 22, names: ['Used', 'Available'] });
area('Pressure (PSI)', 'Linux pressure stall information: share of time at least one task had to wait for CPU, memory or I/O. Sustained values mean the VM is short of that resource even when the usage figures look fine.',
  [prom('rate(node_pressure_cpu_waiting_seconds_total[$__rate_interval])'), prom('rate(node_pressure_memory_waiting_seconds_total[$__rate_interval])'), prom('rate(node_pressure_io_waiting_seconds_total[$__rate_interval])')], pos(16, 33, 8, 8),
  { unit: 'percentunit', softMax: 0.05, names: ['CPU', 'Memory', 'I/O'] });
area('Disk space', 'Used space, computed like df. "/" is the WSL virtual disk: it reports 1 TB but grows inside a file on the Windows drive C:, so C: is the real limit. Dashed line: 90 % (DiskAlmostFull and HostDriveAlmostFull fire at 10 % free).',
  [prom(dfUsed('/'), '/ (WSL virtual disk)'), prom(dfUsed('/mnt/c'), 'C: (Windows drive holding the virtual disk)')], pos(0, 41, 12, 8),
  { unit: 'percentunit', max: 1, thresholdLine: [0.9, C.red] });
area('Network', 'Traffic on the physical network interfaces (eth*); localhost, Docker and Kubernetes interfaces are left out.',
  [prom(`sum(rate(node_network_receive_bytes_total{${NET}}[$__rate_interval]))`), prom(`sum(rate(node_network_transmit_bytes_total{${NET}}[$__rate_interval]))`)], pos(12, 41, 12, 8),
  { unit: 'Bps', names: ['Received', 'Sent'] });
row('Publishing & monitoring', 49);
strip('Publishing & backups', 'The production web root (/var/www/html) and the snapshots that deploy.sh and install-nginx.sh keep in /var/backups/gfilho before every change (the rollback points).', [
  { name: 'Files', q: prom('gfilho_site_files') },
  { name: 'Site size', q: prom('gfilho_site_bytes'), unit: 'decbytes' },
  { name: 'Snapshots', q: prom('sum(gfilho_backup_snapshots)') },
  { name: 'Snapshot size', q: prom('gfilho_backup_bytes'), unit: 'decbytes' },
  { name: 'Newest snapshot', q: prom('time() - max(gfilho_last_deploy_timestamp_seconds)'), unit: 'dtdurations' },
], pos(0, 50, 12, 4), { valueSize: 22 });
strip('Monitoring pipeline', 'Is the monitoring itself working? Scrape targets Prometheus cannot reach (their alerts cannot fire), rule evaluations that failed and log lines Alloy dropped in the selected range, and the age of the custom gfilho_* metrics (the timer runs every 2 minutes; CustomMetricsStale fires after 10).', [
  { name: 'Targets down', q: prom('count(up == 0) or vector(0)'), thresholds: ZERO_OK },
  { name: 'Rule failures (range)', q: prom('round(sum(increase(prometheus_rule_evaluation_failures_total[$__range])))'), thresholds: ZERO_OK },
  { name: 'Log lines dropped (range)', q: prom('round(sum(increase(loki_write_dropped_entries_total[$__range])))'), thresholds: th([C.green, null], [C.amber, 1]) },
  { name: 'Custom metrics age', q: prom('time() - gfilho_metrics_last_run_timestamp_seconds'), unit: 'dtdurations', thresholds: th([C.green, null], [C.amber, 300], [C.red, 600]) },
], pos(12, 50, 12, 4), { valueSize: 22 });
strip('Maintenance', 'Package updates waiting in the local APT cache (SecurityUpdatesPending fires after 3 days) and whether a reboot is needed to finish them.', [
  { name: 'Security updates', q: prom('gfilho_apt_upgradable{kind="security"}'), thresholds: th([C.green, null], [C.amber, 1]) },
  { name: 'All updates', q: prom('gfilho_apt_upgradable{kind="all"}') },
  { name: 'Reboot required', q: prom('gfilho_reboot_required'), mappings: map([[0, 'No', C.green], [1, 'Yes', C.amber]]), thresholds: th([C.green, null], [C.amber, 1]) },
], pos(0, 54, 12, 4), { valueSize: 22 });
chips('Installed versions', 'Hosting components (refreshed every 2 minutes).', prom('gfilho_component_info', '{{component}} {{version}}'), pos(12, 54, 12, 4), C.blue);
row('Logs', 58, { collapsed: true });
logs('nginx errors', 'nginx error.log, without what scanners cause on purpose: a directory without a page ("directory index … is forbidden", answered 404) and an oversized POST ("too large body", answered 413). Both stay visible as 404 and 413 in Top 404s and Unusual requests. Missing files are no longer logged (log_not_found off since 2026-10-21); older "No such file or directory" lines are hidden too. Anything left here is a real nginx problem.',
  '{job="nginx", log="error"} != "directory index of" != "client intended to send too large body" != "failed (2: No such file or directory)"', pos(0, 59, 12, 10));
logs('Service warnings', 'Warnings and errors from cloudflared, nginx, logrotate and the metrics timer (systemd journal).', '{job="systemd-journal"} |~ "(?i)(err|warn|fail)"', pos(12, 59, 12, 10));
logs('Recent visitor requests', 'Latest visitor requests to production, without monitoring probes and automated tools.', ACC, pos(0, 69, 24, 10));
logs('Unusual requests · raw lines', 'The full access-log lines behind "Unusual requests".', `${ACC} ${PAT} ${UNUSUAL}`, pos(0, 79, 24, 10));
finish('gfilho.json', { uid: 'gfilho-overview', title: 'gfilho.net — Monitoring', refresh: '1m', annotations: [ANN.deploys, ANN.wsl, ANN.tunnel],
  description: 'gfilho.net on one page: status, lifecycle, uptime and alerts first, then latency and traffic, visitors and security, services, tunnel, web server, host, publishing and logs' });

// ---------------------------------------------------------------- write
const titles = new Set();
for (const entry of dashboards) validate(entry, titles);
if (new Set(dashboards.map(([, d]) => d.uid)).size !== dashboards.length) throw new Error('duplicate dashboard uid');
for (const [file, d] of dashboards) {
  writeFileSync(join(OUT, file), JSON.stringify(d, null, 2) + '\n');
  const count = d.panels.reduce((n, p) => n + 1 + (p.panels ? p.panels.length : 0), 0);
  const queries = d.panels.flatMap(p => [p, ...(p.panels || [])]).reduce((n, p) => n + (p.targets || []).length, 0);
  console.log(`wrote ${file}: ${d.uid}, ${count} panels (${d.panels.filter(p => p.type === 'row').length} rows), ${queries} queries, refresh ${d.refresh}`);
}
