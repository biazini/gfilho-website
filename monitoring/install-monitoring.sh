#!/usr/bin/env bash
# Install or update the local monitoring stack for guilhermefilho.com (run inside the LXC as root).
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

# 4. firewall before Grafana starts: only the NPM (10.10.10.10) may reach 10.10.10.26:3000
command -v nft >/dev/null || { echo "nftables is required (apt install nftables)" >&2; exit 1; }
install -D -m 644 "$here/nftables/gfilho.nft" /etc/nftables.d/gfilho.nft
grep -q '^include "/etc/nftables.d/\*.nft"' /etc/nftables.conf || echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
systemctl enable nftables >/dev/null 2>&1
nft -f /etc/nftables.d/gfilho.nft
nft list table inet gfilho >/dev/null || { echo "ERROR: nftables table inet gfilho not loaded; not starting Grafana" >&2; exit 1; }
install -D -m 644 "$here/systemd/docker-requires-nftables.conf" /etc/systemd/system/docker.service.d/requires-nftables.conf
systemctl daemon-reload
echo "firewall: Grafana :3000 open to 10.10.10.10 only"

# 5. containers (restart: unless-stopped, so they come back with Docker when the container starts)
compose() { docker compose -f "$dest/docker-compose.yml" "$@"; }
compose pull --quiet
compose up -d --remove-orphans
# "up" only recreates containers whose compose definition changed: apply changed config files as well
# (HUP is sent from inside the container: "docker kill", even with HUP, marks a container as manually stopped,
# and restart: unless-stopped then leaves it down after the next boot)
if grep -q ' prometheus/' <<<"$changed"; then
  compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yml >/dev/null
  compose exec -T prometheus kill -HUP 1 >/dev/null && echo "reload:  prometheus (scrape config and rules)"
fi
if grep -q ' blackbox/' <<<"$changed"; then compose exec -T blackbox-exporter kill -HUP 1 >/dev/null && echo "reload:  blackbox-exporter"; fi
if grep -q ' alloy/' <<<"$changed"; then compose exec -T alloy kill -HUP 1 >/dev/null && echo "reload:  alloy"; fi
if grep -q ' loki/' <<<"$changed"; then compose restart loki >/dev/null && echo "restart: loki"; fi
if grep -q ' grafana/provisioning/' <<<"$changed"; then compose restart grafana >/dev/null && echo "restart: grafana (provisioning)"; fi
# dashboards (grafana/dashboards/*.json) need nothing: Grafana reads that folder again every 60 s

# 6. nothing may listen beyond loopback, except Grafana, the exporters and Alloy on the CT address (behind the firewall above)
sleep 15
ports='3000|3100|9091|9096|9100|9113|9115|12345'
if ss -H -ltn | awk '{print $4}' | grep -E ":($ports)\$" | grep -vE '^(127\.0\.0\.1|\[::1\]):' | grep -vxE '10\.10\.10\.26:(3000|9100|9113|9115|12345)'; then
  echo "ERROR: a monitoring port listens beyond loopback (see above); stopping the stack" >&2
  compose down
  exit 1
fi
compose ps --format 'table {{.Service}}\t{{.Status}}'
echo "Grafana: https://grafana.lab.guilhermefilho.com (via NPM)"
