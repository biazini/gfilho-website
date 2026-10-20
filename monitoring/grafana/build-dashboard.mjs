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
const NORM = '| label_format path=`{{ regexReplaceAll "\\\\?.*$" .path "" }}`';             // /?utm=x counts as /
const BASE = `${ACC} ${PAT} ${LOCAL} ${NORM}`;
const CLASS = '| label_format class=`{{ substr 0 1 .status }}xx`';
const ASSET = '| path !~ `^/(assets|cdn-cgi)/.*` | path !~ `.*\\.(png|ico|svg|xml|txt|webmanifest|jpg|woff2|js|css|map)$`';
const PAGE = '| path =~ `^/(cases/[a-z0-9-]+/)?$`';
const BOT = '(?i).*(bot|crawl|spider|slurp|facebookexternalhit|preview|feed|monitor|scan|python|go-http|wget).*';
const VIEW = '| status=~"200|304"';
const HOME = 'instance="https://gfilho.net/"';
const NET = 'device=~"eth[0-9]+"';                       // physical (mirrored) interfaces only; loopback0 carries localhost traffic

// ---------------------------------------------------------------- overview
row('Overview', 0);
stat('Site', 'https://gfilho.net/ requested from outside every 60 s: DNS → Cloudflare → tunnel → nginx, with a content check.',
  [prom(`min(probe_success{job="blackbox_public", ${HOME}})`)], pos(0, 1, 3, 4), { mappings: UPDOWN, thresholds: th([C.red, null], [C.green, 1]), colorMode: 'background', noValue: 'no data' });
stat('Origin', 'Production nginx (127.0.0.1:8088) requested directly, without Cloudflare or the tunnel.',
  [prom('min(probe_success{job="blackbox_origin", instance="http://127.0.0.1:8088/"})')], pos(3, 1, 3, 4), { mappings: UPDOWN, thresholds: th([C.red, null], [C.green, 1]), colorMode: 'background', noValue: 'no data' });
stat('Tunnel', 'Active connections from cloudflared to the Cloudflare edge. Normal: 4. With 0 the site is offline.',
  [prom('cloudflared_tunnel_ha_connections')], pos(6, 1, 3, 4), { thresholds: th([C.red, null], [C.amber, 1], [C.green, 4]), colorMode: 'background', spark: true, noValue: '0' });
stat('Latency', 'Total time of the latest public request to https://gfilho.net/, as seen from outside.',
  [prom(`max(probe_duration_seconds{job="blackbox_public", ${HOME}})`)], pos(9, 1, 3, 4), { unit: 's', decimals: 0, thresholds: th([C.green, null], [C.amber, 0.6], [C.red, 1.5]), spark: true });
stat('Availability', 'Share of successful public checks in the selected time range. Only counts while monitoring runs: with the PC or WSL off there are no measurements (see "Offline 24 h").',
  [prom(`sum(sum_over_time(probe_success{job="blackbox_public", ${HOME}}[$__range])) / sum(count_over_time(probe_success{job="blackbox_public", ${HOME}}[$__range]))`)], pos(12, 1, 3, 4), { unit: 'percentunit', decimals: 2, thresholds: th([C.red, null], [C.amber, 0.95], [C.green, 0.995]), colorMode: 'background' });
stat('Alerts', 'Firing alert rules (monitoring/prometheus/rules.yml). Details in the table below.',
  [prom('count(ALERTS{alertstate="firing"}) or vector(0)')], pos(15, 1, 3, 4), { thresholds: th([C.green, null], [C.red, 1]), colorMode: 'background' });
stat('Page views', 'Requests to the pages (/ and /cases/*) answered 200, or 304 from the browser cache, in the selected range, without monitoring probes, automated tools or local previews. Logs keep no visitor IP, so there are no "unique visitors".',
  [loki(`sum(count_over_time(${BASE} ${VIEW} ${PAGE} [$__range]))`)], pos(18, 1, 3, 4), { noValue: '0' });
stat('Data served', 'Bytes sent to visitors in the selected range (same filters as Page views).',
  [loki(`sum(sum_over_time(${BASE} | unwrap bytes | __error__="" [$__range]))`)], pos(21, 1, 3, 4), { unit: 'decbytes', noValue: '0 B' });

stat('TLS cert', 'Time left on the certificate Cloudflare serves (renewed automatically). Alert under 14 days.',
  [prom(`max(probe_ssl_earliest_cert_expiry{${HOME}}) - time()`)], pos(0, 5, 3, 4), { unit: 'dtdurations', thresholds: th([C.red, null], [C.amber, 14 * DAY], [C.green, 30 * DAY]) });
stat('security.txt', 'Time left until the Expires date of /.well-known/security.txt. Renew it before 30 days.',
  [prom('gfilho_security_txt_expires_timestamp_seconds - time()')], pos(3, 5, 3, 4), { unit: 'dtdurations', thresholds: th([C.red, null], [C.amber, 30 * DAY], [C.green, 60 * DAY]) });
stat('Last deploy', 'Time since the latest deploy.sh production (from its backup snapshot).',
  [prom('time() - gfilho_last_deploy_timestamp_seconds{target="production"}')], pos(6, 5, 3, 4), { unit: 'dtdurations' });
stat('WSL uptime', 'Time since WSL last started. The site only runs while WSL runs.',
  [prom('time() - node_boot_time_seconds')], pos(9, 5, 3, 4), { unit: 'dtdurations' });
stat('Offline 24 h', 'Time WSL was not running in the last 24 hours, from the systemd journal. The site was offline during that time.',
  [prom('gfilho_wsl_offline_seconds{window="24h"}')], pos(12, 5, 3, 4), { unit: 'dtdurations', thresholds: th([C.green, null], [C.amber, 600], [C.red, 3600]), colorMode: 'background' });
stat('Offline 7 d', 'Time WSL was not running in the last 7 days, from the systemd journal.',
  [prom('gfilho_wsl_offline_seconds{window="7d"}')], pos(15, 5, 3, 4), { unit: 'dtdurations', thresholds: th([C.green, null], [C.amber, 3600], [C.red, 6 * 3600]), colorMode: 'background' });
stat('Updates', 'Ubuntu packages with a pending security update (local APT cache). unattended-upgrades installs them while WSL is running.',
  [prom('gfilho_apt_upgradable{kind="security"}')], pos(18, 5, 3, 4), { thresholds: th([C.green, null], [C.amber, 1], [C.red, 10]), colorMode: 'background' });
stat('Reboot', 'Some updates (kernel, systemd) only take effect after WSL restarts.',
  [prom('gfilho_reboot_required')], pos(21, 5, 3, 4), { mappings: map([[0, 'No', C.green], [1, 'Yes', C.amber]]), thresholds: th([C.green, null], [C.amber, 1]), colorMode: 'background' });

// ---------------------------------------------------------------- alerts
row('Active alerts', 9);
table('Alert details', 'Alerts firing right now, with the time each one became active.',
  [prom('1000 * (ALERTS_FOR_STATE and ignoring(alertstate) ALERTS{alertstate="firing"})')], pos(0, 10, 16, 6), {
    rename: { alertname: 'Alert', severity: 'Severity', component: 'Component', Value: 'Active since', check: 'Check' },
    noValue: 'No active alerts',
    overrides: [
      { matcher: { id: 'byName', options: 'Active since' }, properties: [{ id: 'unit', value: 'dateTimeFromNow' }] },
      { matcher: { id: 'byName', options: 'Severity' }, properties: [{ id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } }, { id: 'mappings', value: map([['critical', 'critical', C.red], ['warning', 'warning', C.amber], ['info', 'info', C.blue]]) }] },
    ],
  });
text('How to read this dashboard',
  '**Site** down but **Origin** up → Cloudflare or the tunnel. Both down → nginx or WSL.\n\n' +
  'Blue markers = **deploys** · orange = **WSL starts**.\n\n' +
  'PC or WSL off = **no data** and no notifications: pair this with an external uptime monitor (README → *Monitoring*).',
  pos(16, 10, 8, 6));

// ---------------------------------------------------------------- availability and latency
row('Availability & latency', 16);
timeline('Checks', 'Green = OK, red = failing. Public pages every 60 s, origin and staging every 30 s, 301 redirects and DNS every 5 min. Blank = monitoring was not running.',
  [prom('probe_success{check!=""}', '{{check}}')], pos(0, 17, 24, 9), OKFAIL);
ts('Public response time by phase', 'Where the time of a request to https://gfilho.net/ goes: DNS, connect, TLS, processing (edge → tunnel → nginx) and transfer.',
  [prom(`sum by (phase) (probe_http_duration_seconds{job="blackbox_public", ${HOME}})`, '{{phase}}')], pos(0, 26, 12, 8), { unit: 's', stack: true, fill: 35 });
ts('Public vs origin', 'Total time from outside (Cloudflare + tunnel) next to nginx answered directly. The difference is the round trip over the internet.',
  [prom('probe_duration_seconds{job=~"blackbox_public|blackbox_origin", check!=""}', '{{check}}')], pos(12, 26, 12, 8), { unit: 's' });

// ---------------------------------------------------------------- traffic
row('Traffic · production', 34);
ts('Responses by status class', 'Visitor requests by HTTP status class (nginx access log). 4xx spikes are usually bots probing for files that do not exist.',
  [loki(`sum by (class) (count_over_time(${BASE} ${CLASS} [$__auto]))`, '{{class}}')], pos(0, 35, 12, 8), { draw: 'bars', stack: true, fill: 85, overrides: STATUS_COLORS });
ts('Requests per second', 'All requests handled by nginx (including staging and the monitoring probes) and those that came in through the tunnel.',
  [prom('rate(nginx_http_requests_total[$__rate_interval])'), prom('rate(cloudflared_tunnel_total_requests[$__rate_interval])')], pos(12, 35, 12, 8),
  { unit: 'reqps', names: ['nginx · all', 'Tunnel · from the internet'], legend: 'table', calcs: ['mean', 'max'] });
topTable('Top pages', 'The 10 most viewed pages (200 or 304), without CSS, JS, images and technical files.',
  `topk(10, sum by (path) (count_over_time(${BASE} ${VIEW} ${ASSET} [$__range])))`, 'path', 'Page', pos(0, 43, 8, 10), C.green);
topTable('Top 404s', 'Requested paths that do not exist. Mostly bots looking for WordPress, .env files and similar: harmless here, none of it exists.',
  `topk(10, sum by (path) (count_over_time(${BASE} | status="404" [$__range])))`, 'path', 'Path', pos(8, 43, 8, 10), C.amber);
topTable('Top referrers', 'Where page views came from (links from the site itself are left out).',
  `topk(10, sum by (referer) (count_over_time(${BASE} ${VIEW} ${PAGE} | referer != "-" | referer !~ \`https?://(www\\.)?gfilho\\.net.*\` [$__range])))`, 'referer', 'Referrer', pos(16, 43, 8, 10), C.purple);
pie('Humans vs bots', 'Page views by client type, from the User-Agent.',
  [loki(`sum(count_over_time(${BASE} ${VIEW} ${PAGE} | agent !~ \`${BOT}\` [$__range]))`), loki(`sum(count_over_time(${BASE} ${VIEW} ${PAGE} | agent =~ \`${BOT}\` [$__range]))`)], pos(0, 53, 6, 8),
  { names: ['Browsers', 'Bots & crawlers'], colors: [C.blue, C.grey] });
// one query per class, so each slice keeps the same colour as in "Responses by status class"
pie('Status mix', 'All visitor requests in the selected range by status class.',
  ['2', '3', '4', '5'].map(c => loki(`sum(count_over_time(${BASE} | status=~"${c}.." [$__range]))`)), pos(6, 53, 6, 8),
  { names: ['2xx', '3xx', '4xx', '5xx'], colors: [C.green, C.blue, C.amber, C.red] });
ts('Bytes served over time', 'Bytes sent to visitors per interval (same filters as above).',
  [loki(`sum(sum_over_time(${BASE} | unwrap bytes | __error__="" [$__auto]))`, 'Bytes')], pos(12, 53, 12, 8), { unit: 'decbytes', draw: 'bars', fill: 80 });

// ---------------------------------------------------------------- tunnel and web server
row('Tunnel & web server', 61);
ts('Edge connections', 'Active tunnel connections (normal 4; dashed line) and new registrations. Many registrations = frequent reconnects.',
  [prom('cloudflared_tunnel_ha_connections'), prom('increase(cloudflared_tunnel_tunnel_register_success[$__rate_interval])')], pos(0, 62, 8, 7),
  { names: ['Active connections', 'New registrations'], decimals: 0, thresholdLine: [4, C.green] });
ts('Tunnel responses by status', 'HTTP status codes returned by the origin through the tunnel.',
  [prom('sum by (status_code) (rate(cloudflared_tunnel_response_by_code[$__rate_interval]))', '{{status_code}}')], pos(8, 62, 8, 7), { unit: 'reqps', stack: true, fill: 50, overrides: CODE_COLORS });
ts('Tunnel errors', 'Requests cloudflared could not deliver to nginx, and stream errors. Should stay at 0.',
  [prom('rate(cloudflared_tunnel_request_errors[$__rate_interval])'), prom('rate(cloudflared_proxy_connect_streams_errors[$__rate_interval])')], pos(16, 62, 8, 7),
  { unit: 'reqps', names: ['Request errors', 'Stream errors'], softMax: 0.1 });
ts('Latency to Cloudflare (QUIC RTT)', 'Smoothed round-trip time of each tunnel connection to the edge.',
  [prom('quic_client_smoothed_rtt', 'Connection {{conn_index}}')], pos(0, 69, 8, 7), { unit: 'ms' });
ts('nginx connections', 'Open connections in nginx (stub_status).',
  [prom('nginx_connections_active'), prom('nginx_connections_reading'), prom('nginx_connections_writing'), prom('nginx_connections_waiting')], pos(8, 69, 8, 7),
  { names: ['Active', 'Reading', 'Writing', 'Idle (keep-alive)'], decimals: 0 });
table('Edge locations', 'Cloudflare data centres the tunnel is connected to (one row per connection).',
  [prom('cloudflared_tunnel_server_locations')], pos(16, 69, 8, 7), { hide: ['Value'], rename: { connection_id: 'Connection', edge_location: 'Edge' } });

// ---------------------------------------------------------------- host
row('Host · WSL', 76);
timeline('Services', 'Green = running.',
  [prom('node_systemd_unit_state{state="active", name=~"nginx.service|cloudflared.service|docker.service|gfilho-metrics.timer"}', '{{name}}')], pos(0, 77, 16, 6),
  map([[0, 'Stopped', C.red], [1, 'Running', C.green]]));
stat('Automatic restarts', 'Times systemd restarted the service (Restart=on-failure) since WSL started, and units in a failed state.',
  [prom('node_systemd_service_restart_total{name="nginx.service"}'), prom('node_systemd_service_restart_total{name="cloudflared.service"}'), prom('sum(node_systemd_unit_state{state="failed"})')],
  pos(16, 77, 8, 6), { names: ['nginx', 'cloudflared', 'Failed units'], thresholds: th([C.green, null], [C.amber, 1]) });
ts('CPU', 'CPU use of the WSL VM (includes the Ascender lab that shares it).',
  [prom('1 - avg(rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval]))', 'CPU')], pos(0, 83, 6, 7), { unit: 'percentunit', max: 1 });
ts('Memory', 'Used and available memory in the WSL VM.',
  [prom('node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes'), prom('node_memory_MemAvailable_bytes')], pos(6, 83, 6, 7),
  { unit: 'bytes', stack: true, fill: 35, names: ['Used', 'Available'] });
ts('Disk', 'Used space on the WSL virtual disk (/), computed like df: used / (used + available), so the blocks ext4 reserves for root are left out.',
  [prom('(node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_free_bytes{mountpoint="/"}) / (node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_free_bytes{mountpoint="/"} + node_filesystem_avail_bytes{mountpoint="/"})', 'Used')], pos(12, 83, 6, 7), { unit: 'percentunit', max: 1, thresholdLine: [0.9, C.red] });
ts('Network', 'Traffic on the physical network interfaces (eth*); localhost, Docker and Kubernetes interfaces are left out.',
  [prom(`sum(rate(node_network_receive_bytes_total{${NET}}[$__rate_interval]))`), prom(`sum(rate(node_network_transmit_bytes_total{${NET}}[$__rate_interval]))`)], pos(18, 83, 6, 7),
  { unit: 'Bps', names: ['Received', 'Sent'] });
stat('Files', 'Files in the production web root (/var/www/html).', [prom('gfilho_site_files')], pos(0, 90, 3, 6));
stat('Site size', 'Total size of the production web root.', [prom('gfilho_site_bytes')], pos(3, 90, 3, 6), { unit: 'decbytes' });
stat('Backups', 'Copies kept by deploy.sh and install-nginx.sh in /var/backups/gfilho.', [prom('sum(gfilho_backup_snapshots)')], pos(6, 90, 3, 6));
stat('Backup size', 'Space used by /var/backups/gfilho.', [prom('gfilho_backup_bytes')], pos(9, 90, 3, 6), { unit: 'decbytes' });
table('Installed versions', 'Hosting components (refreshed every 2 minutes).',
  [prom('gfilho_component_info')], pos(12, 90, 12, 7), { hide: ['Value'], rename: { component: 'Component', version: 'Version' } });

// ---------------------------------------------------------------- logs (collapsed: loads only when opened)
row('Logs', 97, { collapsed: true });
logs('nginx errors', 'nginx error.log. "open() failed" means a request for a file that does not exist (a 404).', '{job="nginx", log="error"}', pos(0, 98, 12, 10));
logs('Service warnings', 'Warnings and errors from cloudflared, nginx, logrotate and the metrics timer (systemd journal).', '{job="systemd-journal"} |~ "(?i)(err|warn|fail)"', pos(12, 98, 12, 10));
logs('Recent requests', 'Latest visitor requests to production, without monitoring probes and automated tools.', ACC, pos(0, 108, 24, 10));

const dashboard = {
  uid: 'gfilho-overview', title: 'gfilho.net — Monitoring', description: 'Availability, traffic, tunnel, services and host of gfilho.net',
  tags: ['gfilho.net', 'website'], timezone: 'browser', editable: false, graphTooltip: 1, schemaVersion: 41, version: 2,
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
