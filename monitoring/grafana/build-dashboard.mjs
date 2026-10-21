// Source of monitoring/grafana/dashboards/gfilho.json, the gfilho.net Grafana dashboard (provisioned read-only).
// Edit this file, then regenerate the JSON and reinstall:
//   node monitoring/grafana/build-dashboard.mjs monitoring/grafana/dashboards/gfilho.json
//   sudo bash monitoring/install-monitoring.sh      # Grafana reloads the dashboard within a minute
// Check the result with monitoring/tests/check-queries.py and check-values.py.
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2];
const PROM = { type: 'prometheus', uid: 'prometheus' };
const LOKI = { type: 'loki', uid: 'loki' };
const DAY = 86400;
const C = { green: '#73BF69', amber: '#FF9830', red: '#F2495C', blue: '#5794F2', purple: '#B877D9', teal: '#2BC4B4', neutral: '#8AB8FF', grey: '#8E8E8E' };

let id = 0;
const top = [];               // top-level panels (rows and the panels of expanded rows)
let into = top;               // where the next panel goes (a collapsed row collects its own)
const pos = (x, y, w, h) => ({ x, y, w, h });
const th = (...steps) => ({ mode: 'absolute', steps: steps.map(([color, value]) => ({ color, value })) });
const prom = (expr, legend = '', extra = {}) => ({ datasource: PROM, expr, legendFormat: legend, ...extra });
const loki = (expr, legend = '', extra = {}) => ({ datasource: LOKI, expr, legendFormat: legend, ...extra });
const refs = ts => ts.map((t, i) => ({ refId: String.fromCharCode(65 + i), ...t }));
const byRef = names => (names || []).map((n, i) => ({ matcher: { id: 'byFrameRefID', options: String.fromCharCode(65 + i) }, properties: [{ id: 'displayName', value: n }] }));
const byName = colors => Object.entries(colors).map(([n, c]) => ({ matcher: { id: 'byName', options: n }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: c } }] }));
const map = (pairs) => [{ type: 'value', options: Object.fromEntries(pairs.map(([v, text, color], i) => [String(v), { text, color, index: i }])) }];
const UPDOWN = map([[0, 'DOWN', C.red], [1, 'UP', C.green]]);
const OKFAIL = map([[0, 'Failing', C.red], [1, 'OK', C.green]]);
const STATUS_COLORS = byName({ '2xx': C.green, '3xx': C.blue, '4xx': C.amber, '5xx': C.red });
const CODE_COLORS = [["2..", C.green], ["3..", C.blue], ["4..", C.amber], ["5..", C.red]].map(([re, c]) => ({ matcher: { id: 'byRegexp', options: re }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: c } }] }));

function push(p) { into.push({ id: ++id, ...p }); }
function row(title, y, { collapsed = false } = {}) {
  const r = { id: ++id, type: 'row', title, collapsed, gridPos: pos(0, y, 24, 1), panels: [] };
  top.push(r);
  into = collapsed ? r.panels : top;
}
function stat(title, description, targets, gridPos, o = {}) {
  const { unit = 'none', thresholds = th([C.neutral, null]), mappings = [], decimals, colorMode = 'value', spark = false, noValue, names, textMode } = o;
  push({
    type: 'stat', title, description, gridPos, datasource: targets[0].datasource,
    targets: refs(targets.map(t => (spark ? { range: true, instant: false, ...t } : { instant: true, range: false, ...(t.datasource === LOKI ? { queryType: 'instant' } : {}), ...t }))),
    fieldConfig: { defaults: { unit, decimals, mappings, thresholds, noValue, color: { mode: 'thresholds' } }, overrides: byRef(names) },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode, graphMode: spark ? 'area' : 'none',
      textMode: textMode || (targets.length > 1 ? 'value_and_name' : 'value'), justifyMode: 'center', orientation: 'auto', wideLayout: true, showPercentChange: false,
    },
  });
}
function ts(title, description, targets, gridPos, o = {}) {
  const { unit = 'short', stack = false, min = 0, max, softMax, decimals, draw = 'line', fill = 18, legend = 'list', calcs = [], overrides = [], thresholdLine, names } = o;
  push({
    type: 'timeseries', title, description, gridPos, datasource: targets[0].datasource,
    targets: refs(targets.map(t => ({ range: true, instant: false, ...(t.datasource === LOKI ? { queryType: 'range' } : {}), ...t }))),
    fieldConfig: {
      defaults: {
        unit, min, max, decimals, color: { mode: 'palette-classic' },
        thresholds: thresholdLine ? th(['transparent', null], [thresholdLine[1], thresholdLine[0]]) : th(['green', null]),
        custom: {
          drawStyle: draw, lineInterpolation: 'smooth', lineWidth: 2, fillOpacity: fill, gradientMode: 'opacity', showPoints: 'never', pointSize: 4,
          spanNulls: false, insertNulls: false, barAlignment: 0, axisBorderShow: false, axisPlacement: 'auto', axisSoftMax: softMax,
          stacking: { mode: stack ? 'normal' : 'none', group: 'A' },
          thresholdsStyle: { mode: thresholdLine ? 'dashed' : 'off' },
        },
      },
      overrides: [...overrides, ...byRef(names)],
    },
    options: { legend: { displayMode: legend, placement: 'bottom', showLegend: true, calcs }, tooltip: { mode: 'multi', sort: 'desc' } },
  });
}
function timeline(title, description, targets, gridPos, mappings) {
  push({
    type: 'state-timeline', title, description, gridPos, datasource: targets[0].datasource,
    targets: refs(targets.map(t => ({ range: true, instant: false, ...t }))),
    fieldConfig: { defaults: { mappings, thresholds: th([C.red, null], [C.green, 1]), color: { mode: 'thresholds' }, custom: { fillOpacity: 75, lineWidth: 0 } }, overrides: [] },
    options: { showValue: 'never', rowHeight: 0.75, mergeValues: true, alignValue: 'center', legend: { showLegend: false }, tooltip: { mode: 'single' } },
  });
}
// Grafana turns a Loki instant result into ONE table (a row per series, value column "Value #A"):
// top-N panels show every row (named after its label); multi-query panels name each query.
function bars(title, description, targets, gridPos, { unit = 'short', color = C.blue, names } = {}) {
  const topN = !names;
  push({
    type: 'bargauge', title, description, gridPos, datasource: targets[0].datasource,
    targets: refs(targets.map(t => ({ queryType: 'instant', instant: true, range: false, ...t }))),
    transformations: topN ? [{ id: 'sortBy', options: { fields: {}, sort: [{ field: 'Value #A', desc: true }] } }] : [],
    fieldConfig: { defaults: { unit, min: 0, thresholds: th([color, null]), color: { mode: 'continuous-BlPu' === color ? color : 'thresholds' }, noValue: 'No requests in this period' }, overrides: byRef(names) },
    options: { orientation: 'horizontal', displayMode: 'gradient', showUnfilled: true, valueMode: 'color', namePlacement: 'top', sizing: 'auto', minVizHeight: 14, maxVizHeight: 22, reduceOptions: { calcs: ['lastNotNull'], fields: topN ? '/^Value/' : '', values: topN, limit: 10 } },
  });
}
// Top-N list as a table: label column + a gauge bar per row (long paths and URLs stay readable).
function topTable(title, description, expr, label, header, gridPos, color) {
  push({
    type: 'table', title, description, gridPos, datasource: LOKI,
    targets: refs([{ datasource: LOKI, expr, legendFormat: `{{${label}}}`, queryType: 'instant', instant: true, range: false }]),
    transformations: [
      { id: 'organize', options: { excludeByName: { Time: true }, renameByName: { [label]: header, 'Value #A': 'Requests' } } },
      { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Requests', desc: true }] } },
    ],
    fieldConfig: {
      defaults: { noValue: 'No requests in this period', custom: { align: 'auto', cellOptions: { type: 'auto' }, inspect: true } },
      overrides: [{ matcher: { id: 'byName', options: 'Requests' }, properties: [
        { id: 'custom.cellOptions', value: { type: 'gauge', mode: 'gradient', valueDisplayMode: 'text' } },
        { id: 'color', value: { mode: 'fixed', fixedColor: color } }, { id: 'min', value: 0 }, { id: 'custom.width', value: 170 }, { id: 'decimals', value: 0 },
      ] }],
    },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
  });
}
function pie(title, description, targets, gridPos, { names, colors = [], overrides = [], allValues = false } = {}) {
  overrides = [...overrides, ...colors.map((c, i) => ({ matcher: { id: 'byFrameRefID', options: String.fromCharCode(65 + i) }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: c } }] }))];
  push({
    type: 'piechart', title, description, gridPos, datasource: targets[0].datasource,
    targets: refs(targets.map(t => ({ queryType: 'instant', instant: true, range: false, ...t }))),
    fieldConfig: { defaults: { unit: 'short', color: { mode: 'palette-classic' }, noValue: 'No requests in this period' }, overrides: [...overrides, ...byRef(names)] },
    options: {
      pieType: 'donut', displayLabels: ['percent'], reduceOptions: { calcs: ['lastNotNull'], fields: allValues ? '/^Value/' : '', values: allValues },
      legend: { displayMode: 'table', placement: 'right', showLegend: true, values: ['value', 'percent'] }, tooltip: { mode: 'single' },
    },
  });
}
function table(title, description, targets, gridPos, { hide = [], rename = {}, overrides = [], noValue } = {}) {
  const exclude = Object.fromEntries(['Time', '__name__', 'instance', 'job', ...hide].map(k => [k, true]));
  push({
    type: 'table', title, description, gridPos, datasource: targets[0].datasource,
    targets: refs(targets.map(t => ({ instant: true, range: false, format: 'table', ...t }))),
    transformations: [{ id: 'organize', options: { excludeByName: exclude, renameByName: rename } }],
    fieldConfig: { defaults: { noValue, custom: { align: 'auto', cellOptions: { type: 'auto' }, inspect: false } }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
  });
}
function logs(title, description, expr, gridPos) {
  push({
    type: 'logs', title, description, gridPos, datasource: LOKI,
    targets: refs([{ datasource: LOKI, expr, queryType: 'range' }]),
    options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true, dedupStrategy: 'none', prettifyLogMessage: false, showCommonLabels: false, showLabels: false },
  });
}
function text(title, content, gridPos) { push({ type: 'text', title, gridPos, options: { mode: 'markdown', content } }); }

// ---------------------------------------------------------------- shared LogQL pieces
// visitor traffic: production log (staging only gets local previews), without the dashboard's own probes and other automated tools
const NOISE = 'gfilho-monitor|curl/|[Pp]ython-urllib|HeadlessChrome|Chrome-Lighthouse';
const ACC = `{job="nginx", log="access", env="production"} !~ "${NOISE}"`;
const PAT = '| pattern `<_> - <_> [<_>] "<method> <path> <_>" <status> <bytes> "<referer>" "<agent>"<_>`';
const LOCAL = '| referer !~ `https?://(localhost|127\\.0\\.0\\.1)([:/].*)?`';            // local previews are not visitors
const NORM = '| label_format page=`{{ regexReplaceAll "\\\\?.*$" .path "" }}`';             // page = path without ?query (/?utm=x counts as /). A new label on purpose: later filters ignore an overwritten "path"
const BASE = `${ACC} ${PAT} ${LOCAL} ${NORM}`;
const CLASS = '| label_format class=`{{ substr 0 1 .status }}xx`';
const ASSET = '| page !~ `^/(assets|cdn-cgi)/.*` | page !~ `.*\\.(png|ico|svg|xml|txt|webmanifest|jpg|woff2|js|css|map)$`';
const PAGE = '| page =~ `^/(cases/[a-z0-9-]+/)?$`';
const BOT = '(?i).*(bot|crawl|spider|slurp|facebookexternalhit|preview|feed|monitor|scan|python|go-http|wget).*';
const VIEW = '| status=~"200|304"';
const HOME = 'instance="https://gfilho.net/"';
const NET = 'device=~"eth[0-9]+"';                       // physical (mirrored) interfaces only; loopback0 carries localhost traffic

// ---------------------------------------------------------------- modern building blocks
// Every query below is the same expression as before; these helpers only change how it is drawn.
const MIXED = { type: 'datasource', uid: '-- Mixed --' };
const refAt = i => String.fromCharCode(65 + i);
const forRef = (i, props) => ({ matcher: { id: 'byFrameRefID', options: refAt(i) }, properties: props });

// One borderless strip of values (replaces a row of separate stat boxes). Each item keeps its own
// query, unit, thresholds and mappings through per-query overrides.
function strip(title, description, items, gridPos, { valueSize = 30, titleSize = 13 } = {}) {
  const ds = new Set(items.map(it => it.q.datasource.uid));
  push({
    type: 'stat', title, description, gridPos, transparent: true, datasource: ds.size > 1 ? MIXED : items[0].q.datasource,
    targets: refs(items.map(it => (it.range ? { range: true, instant: false, ...it.q } : { instant: true, range: false, ...(it.q.datasource === LOKI ? { queryType: 'instant' } : {}), ...it.q }))),
    fieldConfig: {
      defaults: { unit: 'none', color: { mode: 'thresholds' }, thresholds: th([C.neutral, null]), mappings: [] },
      overrides: items.map((it, i) => forRef(i, [
        { id: 'displayName', value: it.name },
        { id: 'unit', value: it.unit || 'none' },
        { id: 'thresholds', value: it.thresholds || th([C.neutral, null]) },
        ...(it.mappings ? [{ id: 'mappings', value: it.mappings }] : []),
        ...(it.decimals !== undefined ? [{ id: 'decimals', value: it.decimals }] : []),
        ...(it.noValue ? [{ id: 'noValue', value: it.noValue }] : []),
      ])),
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'value', graphMode: 'none', textMode: 'value_and_name',
      justifyMode: 'center', orientation: 'vertical', wideLayout: true, showPercentChange: false, text: { titleSize, valueSize },
    },
  });
}
// Labels shown as small coloured chips (replaces short tables such as versions or edge locations).
function chips(title, description, target, gridPos, color = C.green, transformations = []) {
  push({
    type: 'stat', title, description, gridPos, transparent: true, datasource: target.datasource, transformations,
    targets: refs([{ instant: true, range: false, ...target }]),
    fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: color }, thresholds: th([color, null]) }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'background', graphMode: 'none', textMode: 'name',
      justifyMode: 'center', orientation: 'vertical', wideLayout: true, showPercentChange: false, text: { titleSize: 12, valueSize: 15 } },
  });
}
// Smooth area chart with a subtle gradient; per-query tweaks through `per` (refId index -> properties).
function area(title, description, targets, gridPos, o = {}) {
  const { unit = 'short', stack = false, min = 0, max, softMax, decimals, fill = 14, legend = 'list', calcs = [], overrides = [], thresholdLine, names, per = {} } = o;
  push({
    type: 'timeseries', title, description, gridPos, datasource: targets[0].datasource,
    targets: refs(targets.map(t => ({ range: true, instant: false, ...(t.datasource === LOKI ? { queryType: 'range' } : {}), ...t }))),
    fieldConfig: {
      defaults: {
        unit, min, max, decimals, color: { mode: 'palette-classic' },
        thresholds: thresholdLine ? th(['transparent', null], [thresholdLine[1], thresholdLine[0]]) : th(['green', null]),
        custom: {
          drawStyle: 'line', lineInterpolation: 'smooth', lineWidth: 1.5, fillOpacity: fill, gradientMode: 'opacity', showPoints: 'never',
          spanNulls: false, insertNulls: false, axisBorderShow: false, axisPlacement: 'auto', axisSoftMax: softMax, axisGridShow: true,
          stacking: { mode: stack ? 'normal' : 'none', group: 'A' }, thresholdsStyle: { mode: thresholdLine ? 'dashed' : 'off' },
        },
      },
      overrides: [...overrides, ...byRef(names), ...Object.entries(per).map(([i, props]) => forRef(+i, props))],
    },
    options: { legend: { displayMode: legend, placement: 'bottom', showLegend: true, calcs }, tooltip: { mode: 'multi', sort: 'desc' } },
  });
}
// Horizontal bar chart for a top-N Loki instant query (one row per label value).
function barchart(title, description, expr, label, header, gridPos, color) {
  push({
    type: 'barchart', title, description, gridPos, datasource: LOKI,
    targets: refs([{ datasource: LOKI, expr, legendFormat: `{{${label}}}`, queryType: 'instant', instant: true, range: false }]),
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
// Grid of cells per series over time, a heatmap-style status history.
function history(title, description, target, gridPos, mappings, interval) {
  push({
    type: 'status-history', title, description, gridPos, datasource: target.datasource, interval, maxDataPoints: 96,
    targets: refs([{ range: true, instant: false, ...target }]),
    fieldConfig: { defaults: { mappings, thresholds: th([C.red, null], [C.green, 1]), color: { mode: 'thresholds' }, custom: { fillOpacity: 80, lineWidth: 1 } }, overrides: [] },
    options: { showValue: 'never', rowHeight: 0.85, colWidth: 0.92, legend: { showLegend: false }, tooltip: { mode: 'single' } },
  });
}
// Grafana's native alert list (reads the rules of the Prometheus data source).
function alertList(title, description, gridPos) {
  push({
    type: 'alertlist', title, description, gridPos,
    options: { viewMode: 'list', groupMode: 'default', groupBy: [], maxItems: 20, sortOrder: 1, dashboardAlerts: false, alertName: '', alertInstanceLabelFilter: '',
      showInstances: false, stateFilter: { firing: true, pending: true, noData: false, normal: false, error: true, recovering: true } },
  });
}
// Cloudflare names its data centres after the nearest airport (IATA code): show the city instead.
const CITIES = { lis: 'Lisbon', opo: 'Porto', mad: 'Madrid', bcn: 'Barcelona', ams: 'Amsterdam', fra: 'Frankfurt', cdg: 'Paris', mrs: 'Marseille',
  lhr: 'London', man: 'Manchester', dub: 'Dublin', bru: 'Brussels', dus: 'Düsseldorf', ham: 'Hamburg', muc: 'Munich', mxp: 'Milan', fco: 'Rome', zrh: 'Zurich',
  gva: 'Geneva', vie: 'Vienna', prg: 'Prague', waw: 'Warsaw', cph: 'Copenhagen', arn: 'Stockholm', osl: 'Oslo', hel: 'Helsinki', ath: 'Athens', iad: 'Ashburn', ewr: 'Newark', gru: 'São Paulo' };
const EDGE_NAMES = Object.entries(CITIES).map(([code, city]) => ({ id: 'renameByRegex', options: {
  regex: '^Connection (\\d+) · ' + code + '(\\d+)$', renamePattern: 'Connection $1 → ' + city + ' (' + code.toUpperCase() + '$2)' } }));
const FIRING = [{ type: 'range', options: { from: 1, to: 1e15, result: { text: 'Firing', color: C.red, index: 0 } } }];

// ---------------------------------------------------------------- overview
row('Overview', 0);
strip('Health', 'Live state of the site. Site down but Origin up → Cloudflare or the tunnel; both down → nginx or WSL. With the PC or WSL off there is no data and nothing here can notify you: pair this with an external uptime monitor (README → Monitoring).', [
  { name: 'Site', q: prom(`min(probe_success{job="blackbox_public", ${HOME}})`), mappings: UPDOWN, thresholds: th([C.red, null], [C.green, 1]), noValue: 'no data' },
  { name: 'Origin', q: prom('min(probe_success{job="blackbox_origin", instance="http://127.0.0.1:8088/"})'), mappings: UPDOWN, thresholds: th([C.red, null], [C.green, 1]), noValue: 'no data' },
  { name: 'Tunnel', q: prom('cloudflared_tunnel_ha_connections'), range: true, thresholds: th([C.red, null], [C.amber, 1], [C.green, 4]), noValue: '0' },
  { name: 'Latency', q: prom(`max(probe_duration_seconds{job="blackbox_public", ${HOME}})`), range: true, unit: 's', decimals: 0, thresholds: th([C.green, null], [C.amber, 0.6], [C.red, 1.5]) },
  { name: 'Availability', q: prom(`sum(sum_over_time(probe_success{job="blackbox_public", ${HOME}}[$__range])) / sum(count_over_time(probe_success{job="blackbox_public", ${HOME}}[$__range]))`), unit: 'percentunit', decimals: 2, thresholds: th([C.red, null], [C.amber, 0.95], [C.green, 0.995]) },
  { name: 'Alerts', q: prom('count(ALERTS{alertstate="firing"}) or vector(0)'), thresholds: th([C.green, null], [C.red, 1]) },
  { name: 'Page views', q: loki(`sum(count_over_time(${BASE} ${VIEW} ${PAGE} [$__range]))`), noValue: '0' },
  { name: 'Data served', q: loki(`sum(sum_over_time(${BASE} | unwrap bytes | __error__="" [$__range]))`), unit: 'decbytes', noValue: '0 B' },
], pos(0, 1, 24, 4), { valueSize: 34 });
strip('Lifecycle', 'TLS expires and sec.txt expires = time left until the TLS certificate and /.well-known/security.txt expire (renew security.txt before 30 days; Cloudflare renews the certificate). Offline = time WSL was not running (from the systemd journal): the site was down then.', [
  { name: 'TLS expires', q: prom(`max(probe_ssl_earliest_cert_expiry{${HOME}}) - time()`), unit: 'dtdurations', thresholds: th([C.red, null], [C.amber, 14 * DAY], [C.green, 30 * DAY]) },
  { name: 'sec.txt expires', q: prom('gfilho_security_txt_expires_timestamp_seconds - time()'), unit: 'dtdurations', thresholds: th([C.red, null], [C.amber, 30 * DAY], [C.green, 60 * DAY]) },
  { name: 'Last deploy', q: prom('time() - gfilho_last_deploy_timestamp_seconds{target="production"}'), unit: 'dtdurations' },
  { name: 'WSL uptime', q: prom('time() - node_boot_time_seconds'), unit: 'dtdurations' },
  { name: 'Offline 24 h', q: prom('gfilho_wsl_offline_seconds{window="24h"}'), unit: 'dtdurations', thresholds: th([C.green, null], [C.amber, 600], [C.red, 3600]) },
  { name: 'Offline 7 d', q: prom('gfilho_wsl_offline_seconds{window="7d"}'), unit: 'dtdurations', thresholds: th([C.green, null], [C.amber, 3600], [C.red, 6 * 3600]) },
  { name: 'Security updates', q: prom('gfilho_apt_upgradable{kind="security"}'), thresholds: th([C.green, null], [C.amber, 1], [C.red, 10]) },
  { name: 'Reboot', q: prom('gfilho_reboot_required'), mappings: map([[0, 'No', C.green], [1, 'Yes', C.amber]]), thresholds: th([C.green, null], [C.amber, 1]) },
], pos(0, 5, 24, 3), { valueSize: 17, titleSize: 11 });
timeline('Uptime', 'Every check as one continuous status line. Green = OK, red = failing. Public pages every 60 s, origin and staging every 30 s, 301 redirects and DNS every 5 min. Blank = monitoring was not running.',
  [prom('probe_success{check!=""}', '{{check}}')], pos(0, 8, 24, 8), OKFAIL);
top.at(-1).transparent = true;

// ---------------------------------------------------------------- alerts
row('Alerts', 16);
alertList('Firing now', 'Native Grafana alert list of the Prometheus rules (monitoring/prometheus/rules.yml).', pos(0, 17, 9, 7));
timeline('Alert history', 'When each alert was firing in the selected range (red bars).',
  [prom('1000 * (ALERTS_FOR_STATE and ignoring(alertstate) ALERTS{alertstate="firing"})', '{{alertname}} · {{severity}}')], pos(9, 17, 15, 7), FIRING);
top.at(-1).fieldConfig.defaults.noValue = 'No alerts in this period';
top.at(-1).fieldConfig.defaults.thresholds = th([C.red, null]);

// ---------------------------------------------------------------- latency
row('Latency', 24);
area('Response time by phase', 'Where the time of a request to https://gfilho.net/ goes: DNS, connect, TLS, processing (edge → tunnel → nginx) and transfer.',
  [prom(`sum by (phase) (probe_http_duration_seconds{job="blackbox_public", ${HOME}})`, '{{phase}}')], pos(0, 25, 12, 8), { unit: 's', stack: true, fill: 22 });
area('Public vs origin', 'Total time from outside (Cloudflare + tunnel) next to nginx answered directly. The difference is the round trip over the internet.',
  [prom('probe_duration_seconds{job=~"blackbox_public|blackbox_origin", check!=""}', '{{check}}')], pos(12, 25, 12, 8), { unit: 's', fill: 8 });

// ---------------------------------------------------------------- traffic
row('Traffic · production', 33);
area('Responses by status class', 'Visitor requests by HTTP status class (nginx access log). 4xx spikes are usually bots probing for files that do not exist.',
  [loki(`sum by (class) (count_over_time(${BASE} ${CLASS} [$__auto]))`, '{{class}}')], pos(0, 34, 12, 8), { stack: true, fill: 30, overrides: STATUS_COLORS });
area('Requests per second', 'All requests handled by nginx (including staging and the monitoring probes) and those that came in through the tunnel.',
  [prom('rate(nginx_http_requests_total[$__rate_interval])'), prom('rate(cloudflared_tunnel_total_requests[$__rate_interval])')], pos(12, 34, 12, 8),
  { unit: 'reqps', names: ['nginx · all', 'Tunnel · from the internet'], legend: 'table', calcs: ['mean', 'max'] });
barchart('Top pages', 'The 10 most viewed pages (200 or 304), without CSS, JS, images and technical files.',
  `topk(10, sum by (page) (count_over_time(${BASE} ${VIEW} ${ASSET} [$__range])))`, 'page', 'Page', pos(0, 42, 8, 9), C.green);
barchart('Top 404s', 'Requested paths that do not exist. Mostly bots looking for WordPress, .env files and similar: harmless here, none of it exists.',
  `topk(10, sum by (page) (count_over_time(${BASE} | status="404" [$__range])))`, 'page', 'Path', pos(8, 42, 8, 9), C.amber);
barchart('Top referrers', 'Where page views came from (links from the site itself are left out).',
  `topk(10, sum by (referer) (count_over_time(${BASE} ${VIEW} ${PAGE} | referer != "-" | referer !~ \`https?://(www\\.)?gfilho\\.net.*\` [$__range])))`, 'referer', 'Referrer', pos(16, 42, 8, 9), C.purple);
pie('Humans vs bots', 'Page views by client type, from the User-Agent.',
  [loki(`sum(count_over_time(${BASE} ${VIEW} ${PAGE} | agent !~ \`${BOT}\` [$__range]))`), loki(`sum(count_over_time(${BASE} ${VIEW} ${PAGE} | agent =~ \`${BOT}\` [$__range]))`)], pos(0, 51, 6, 8),
  { names: ['Browsers', 'Bots & crawlers'], colors: [C.blue, C.grey] });
top.at(-1).transparent = true;
// one query per class, so each slice keeps the same colour as in "Responses by status class"
pie('Status mix', 'All visitor requests in the selected range by status class.',
  ['2', '3', '4', '5'].map(c => loki(`sum(count_over_time(${BASE} | status=~"${c}.." [$__range]))`)), pos(6, 51, 6, 8),
  { names: ['2xx', '3xx', '4xx', '5xx'], colors: [C.green, C.blue, C.amber, C.red] });
top.at(-1).transparent = true;
area('Bytes served', 'Bytes sent to visitors per interval (same filters as Page views).',
  [loki(`sum(sum_over_time(${BASE} | unwrap bytes | __error__="" [$__auto]))`, 'Bytes')], pos(12, 51, 12, 8), { unit: 'decbytes', fill: 24 });

// ---------------------------------------------------------------- tunnel and web server
row('Tunnel & web server', 59);
// grouped: tunnel responses (stacked areas) with its two error rates (lines) on the same req/s axis
area('Tunnel traffic & errors', 'HTTP status codes returned by the origin through the tunnel (areas), and requests or streams cloudflared could not deliver (red lines, should stay at 0).',
  [prom('sum by (status_code) (rate(cloudflared_tunnel_response_by_code[$__rate_interval]))', '{{status_code}}'),
   prom('rate(cloudflared_tunnel_request_errors[$__rate_interval])'), prom('rate(cloudflared_proxy_connect_streams_errors[$__rate_interval])')], pos(0, 60, 12, 8),
  { unit: 'reqps', stack: true, fill: 22, overrides: CODE_COLORS, per: {
    1: [{ id: 'displayName', value: 'Request errors' }, { id: 'custom.stacking', value: { mode: 'none', group: 'errors' } }, { id: 'custom.fillOpacity', value: 0 }, { id: 'color', value: { mode: 'fixed', fixedColor: C.red } }],
    2: [{ id: 'displayName', value: 'Stream errors' }, { id: 'custom.stacking', value: { mode: 'none', group: 'errors' } }, { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineStyle', value: { fill: 'dash', dash: [6, 4] } }, { id: 'color', value: { mode: 'fixed', fixedColor: C.red } }],
  } });
// grouped: the health of the tunnel link — connections (left axis, normal 4) and QUIC latency (right axis)
area('Edge link', 'Active tunnel connections (normal 4, dashed line) and new registrations on the left axis; smoothed QUIC round-trip time of each connection on the right axis.',
  [prom('cloudflared_tunnel_ha_connections'), prom('increase(cloudflared_tunnel_tunnel_register_success[$__rate_interval])'), prom('quic_client_smoothed_rtt', 'RTT · connection {{conn_index}}')], pos(12, 60, 12, 8),
  { decimals: 0, fill: 6, thresholdLine: [4, C.green], per: {
    0: [{ id: 'displayName', value: 'Active connections' }, { id: 'color', value: { mode: 'fixed', fixedColor: C.green } }, { id: 'custom.fillOpacity', value: 16 }],
    1: [{ id: 'displayName', value: 'New registrations' }, { id: 'color', value: { mode: 'fixed', fixedColor: C.amber } }],
    2: [{ id: 'unit', value: 'ms' }, { id: 'custom.axisPlacement', value: 'right' }, { id: 'custom.axisLabel', value: 'RTT' }, { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineWidth', value: 1 }],
  } });
area('nginx connections', 'Open connections in nginx (stub_status).',
  [prom('nginx_connections_active'), prom('nginx_connections_reading'), prom('nginx_connections_writing'), prom('nginx_connections_waiting')], pos(0, 68, 12, 7),
  { names: ['Active', 'Reading', 'Writing', 'Idle (keep-alive)'], decimals: 0 });
chips('Tunnel → Cloudflare data centres', 'cloudflared keeps 4 connections open to the Cloudflare network for redundancy. Each chip shows the Cloudflare data centre one connection is attached to (named after the nearest airport: LIS = Lisbon, AMS = Amsterdam). Visitors reach the site through any of them; if one drops, the others keep it online.',
  prom('cloudflared_tunnel_server_locations', 'Connection {{connection_id}} · {{edge_location}}'), pos(12, 68, 12, 4), C.teal, EDGE_NAMES);

// ---------------------------------------------------------------- host
row('Host · WSL', 75);
history('Services', 'systemd state of the hosting services as a status grid (green = running, red = stopped), one cell per interval.',
  prom('node_systemd_unit_state{state="active", name=~"nginx.service|cloudflared.service|docker.service|gfilho-metrics.timer"}', '{{name}}'), pos(0, 76, 16, 6),
  map([[0, 'Stopped', C.red], [1, 'Running', C.green]]), '5m');
strip('Automatic restarts', 'Times systemd restarted the service (Restart=on-failure) since WSL started, and units in a failed state.', [
  { name: 'nginx', q: prom('node_systemd_service_restart_total{name="nginx.service"}'), thresholds: th([C.green, null], [C.amber, 1]) },
  { name: 'cloudflared', q: prom('node_systemd_service_restart_total{name="cloudflared.service"}'), thresholds: th([C.green, null], [C.amber, 1]) },
  { name: 'Failed units', q: prom('sum(node_systemd_unit_state{state="failed"})'), thresholds: th([C.green, null], [C.amber, 1]) },
], pos(16, 76, 8, 6), { valueSize: 28 });
// grouped: CPU and disk share the 0-100 % axis
area('CPU & disk', 'CPU use of the WSL VM (includes the Ascender lab that shares it) and used space on the virtual disk (/), computed like df. Dashed line: 90 %.',
  [prom('1 - avg(rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval]))', 'CPU'),
   prom('(node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_free_bytes{mountpoint="/"}) / (node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_free_bytes{mountpoint="/"} + node_filesystem_avail_bytes{mountpoint="/"})', 'Disk used')],
  pos(0, 82, 8, 7), { unit: 'percentunit', max: 1, thresholdLine: [0.9, C.red] });
area('Memory', 'Used and available memory in the WSL VM.',
  [prom('node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes'), prom('node_memory_MemAvailable_bytes')], pos(8, 82, 8, 7),
  { unit: 'bytes', stack: true, fill: 22, names: ['Used', 'Available'] });
area('Network', 'Traffic on the physical network interfaces (eth*); localhost, Docker and Kubernetes interfaces are left out.',
  [prom(`sum(rate(node_network_receive_bytes_total{${NET}}[$__rate_interval]))`), prom(`sum(rate(node_network_transmit_bytes_total{${NET}}[$__rate_interval]))`)], pos(16, 82, 8, 7),
  { unit: 'Bps', names: ['Received', 'Sent'] });
strip('Publishing', 'The production web root (/var/www/html) and the snapshots kept by deploy.sh and install-nginx.sh in /var/backups/gfilho.', [
  { name: 'Files', q: prom('gfilho_site_files') },
  { name: 'Site size', q: prom('gfilho_site_bytes'), unit: 'decbytes' },
  { name: 'Backups', q: prom('sum(gfilho_backup_snapshots)') },
  { name: 'Backup size', q: prom('gfilho_backup_bytes'), unit: 'decbytes' },
], pos(0, 89, 24, 4), { valueSize: 24 });
chips('Installed versions', 'Hosting components (refreshed every 2 minutes).', prom('gfilho_component_info', '{{component}} {{version}}'), pos(12, 72, 12, 3), C.blue);

// ---------------------------------------------------------------- logs (collapsed: loads only when opened)
row('Logs', 93, { collapsed: true });
logs('nginx errors', 'nginx error.log. "open() failed" means a request for a file that does not exist (a 404).', '{job="nginx", log="error"}', pos(0, 94, 12, 10));
logs('Service warnings', 'Warnings and errors from cloudflared, nginx, logrotate and the metrics timer (systemd journal).', '{job="systemd-journal"} |~ "(?i)(err|warn|fail)"', pos(12, 94, 12, 10));
logs('Recent requests', 'Latest visitor requests to production, without monitoring probes and automated tools.', ACC, pos(0, 104, 24, 10));

const dashboard = {
  uid: 'gfilho-overview', title: 'gfilho.net — Monitoring', description: 'Availability, traffic, tunnel, services and host of gfilho.net',
  tags: ['gfilho.net', 'website'], timezone: 'browser', editable: false, graphTooltip: 1, schemaVersion: 41, version: 3,
  time: { from: 'now-24h', to: 'now' }, refresh: '1m', fiscalYearStartMonth: 0, liveNow: false,
  timepicker: { refresh_intervals: ['30s', '1m', '5m', '15m', '1h'] },
  templating: { list: [] },
  annotations: {
    list: [
      { builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' },
      { datasource: PROM, enable: true, iconColor: C.blue, name: 'Deploys', expr: 'changes(gfilho_last_deploy_timestamp_seconds{target="production"}[3m]) > 0', step: '1m', titleFormat: 'Deploy to production', textFormat: 'deploy.sh production' },
      { datasource: PROM, enable: true, iconColor: C.amber, name: 'WSL starts', expr: 'changes(node_boot_time_seconds[3m]) > 0', step: '1m', titleFormat: 'WSL started', textFormat: 'The site was offline before this point' },
    ],
  },
  links: [
    { title: 'Live site', url: 'https://gfilho.net/', type: 'link', targetBlank: true, icon: 'external link' },
    { title: 'Prometheus alerts', url: 'http://localhost:9091/alerts', type: 'link', targetBlank: true, icon: 'bolt' },
    { title: 'Repository', url: 'https://github.com/biazini/gfilho-website', type: 'link', targetBlank: true, icon: 'doc' },
  ],
  panels: top,
};
writeFileSync(OUT, JSON.stringify(dashboard, null, 2) + '\n');
const count = top.reduce((n, p) => n + 1 + (p.panels ? p.panels.length : 0), 0);
console.log(`wrote ${count} panels (${top.filter(p => p.type === 'row').length} rows) to ${OUT}`);
