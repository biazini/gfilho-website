#!/usr/bin/env bash
# Install or update the local monitoring stack for gfilho.net (run inside WSL as root).
#
#   sudo monitoring/install-monitoring.sh
#
# Copies monitoring/ to /opt/gfilho-monitoring, generates the Grafana admin password once
# (/etc/gfilho-monitoring/grafana.env, root only, never in Git), installs the custom-metrics timer
# and starts the containers. Grafana: http://localhost:3000 (read-only view without login).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
dest=/opt/gfilho-monitoring

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
curl -fsS -o /dev/null http://127.0.0.1:8090/stub_status \
  || { echo "nginx stub_status (127.0.0.1:8090) not found: run deploy/install-nginx.sh first" >&2; exit 1; }

# 1. configuration
install -d -m 755 "$dest"
changed="$(rsync -ai --delete --chmod=D755,F644 \
  --exclude 'install-monitoring.sh' --exclude 'systemd/' --exclude 'textfile/' --exclude 'tests/' \
  "$here/" "$dest/")"
echo "config:  $here -> $dest ($(grep -c '^[<>c*]f' <<<"$changed" || true) files changed)"

# 2. Grafana admin password, generated once
install -d -m 700 /etc/gfilho-monitoring
if [ ! -s /etc/gfilho-monitoring/grafana.env ]; then
  ( umask 077; printf 'GF_SECURITY_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 30 | tr -d '/+=\n')" > /etc/gfilho-monitoring/grafana.env )
  echo "secret:  Grafana admin password created in /etc/gfilho-monitoring/grafana.env (read it with: sudo cat)"
fi

# 3. custom gfilho_* metrics for node_exporter
install -d -m 755 /var/lib/gfilho-monitoring/textfile
install -m 755 "$here/textfile/gfilho-metrics.py" /usr/local/sbin/gfilho-metrics
install -m 644 "$here/systemd/gfilho-metrics.service" "$here/systemd/gfilho-metrics.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gfilho-metrics.timer >/dev/null
systemctl start gfilho-metrics.service
echo "metrics: $(grep -c '^gfilho_' /var/lib/gfilho-monitoring/textfile/gfilho.prom) gfilho_* samples"

# 4. containers (restart: unless-stopped, so they come back with Docker when WSL starts)
compose() { docker compose -f "$dest/docker-compose.yml" "$@"; }
compose pull --quiet
compose up -d --remove-orphans
# "up" only recreates containers whose compose definition changed: apply changed config files as well
if grep -q ' prometheus/' <<<"$changed"; then
  compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yml >/dev/null
  compose kill -s HUP prometheus >/dev/null && echo "reload:  prometheus (scrape config and rules)"
fi
if grep -q ' blackbox/' <<<"$changed"; then compose kill -s HUP blackbox-exporter >/dev/null && echo "reload:  blackbox-exporter"; fi
if grep -q ' alloy/' <<<"$changed"; then compose kill -s HUP alloy >/dev/null && echo "reload:  alloy"; fi
if grep -q ' loki/' <<<"$changed"; then compose restart loki >/dev/null && echo "restart: loki"; fi
if grep -q ' grafana/provisioning/' <<<"$changed"; then compose restart grafana >/dev/null && echo "restart: grafana (provisioning)"; fi
# dashboards (grafana/dashboards/*.json) need nothing: Grafana reads that folder again every 60 s

# 5. nothing may listen beyond loopback
sleep 15
ports='3000|3100|9091|9096|9100|9113|9115|12345'
if ss -H -ltn | awk '{print $4}' | grep -E ":($ports)\$" | grep -vE '^(127\.0\.0\.1|\[::1\]):'; then
  echo "ERROR: a monitoring port listens beyond loopback (see above); stopping the stack" >&2
  compose down
  exit 1
fi
compose ps --format 'table {{.Service}}\t{{.Status}}'
echo "Grafana: http://localhost:3000"
