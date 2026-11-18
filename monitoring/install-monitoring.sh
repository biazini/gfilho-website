#!/usr/bin/env bash
# Install or update the site's exporters for guilhermefilho.com (run inside CT 107 as root).
#
#   bash monitoring/install-monitoring.sh
#
# Copies monitoring/ to /opt/gfilho-monitoring, installs the custom-metrics timer and the firewall, and starts
# node-exporter, nginx-exporter, blackbox-exporter (origin probes) and Alloy. Prometheus, Loki, Grafana and the
# alerts run in the gfhomelab observability stack (CT 108); Grafana: https://grafana.lab.guilhermefilho.com
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

# 3. custom gfilho_* metrics for node_exporter
install -d -m 755 /var/lib/gfilho-monitoring/textfile
install -m 755 "$here/textfile/gfilho-metrics.py" /usr/local/sbin/gfilho-metrics
install -m 644 "$here/systemd/gfilho-metrics.service" "$here/systemd/gfilho-metrics.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gfilho-metrics.timer >/dev/null
systemctl start gfilho-metrics.service
echo "metrics: $(grep -c '^gfilho_' /var/lib/gfilho-monitoring/textfile/gfilho.prom) gfilho_* samples"

# 4. firewall: only CT 108 (10.10.10.27) may reach the exporters on 10.10.10.26
command -v nft >/dev/null || { echo "nftables is required (apt install nftables)" >&2; exit 1; }
install -D -m 644 "$here/nftables/gfilho.nft" /etc/nftables.d/gfilho.nft
grep -q '^include "/etc/nftables.d/\*.nft"' /etc/nftables.conf || echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
systemctl enable nftables >/dev/null 2>&1
nft -f /etc/nftables.d/gfilho.nft
nft list table inet gfilho >/dev/null || { echo "ERROR: nftables table inet gfilho not loaded; not starting the exporters" >&2; exit 1; }
install -D -m 644 "$here/systemd/docker-requires-nftables.conf" /etc/systemd/system/docker.service.d/requires-nftables.conf
systemctl daemon-reload
echo "firewall: exporters open to 10.10.10.27 (CT 108) only"

# 5. containers (restart: unless-stopped, so they come back with Docker when the container starts)
compose() { docker compose -f "$dest/docker-compose.yml" "$@"; }
compose pull --quiet
compose up -d --remove-orphans
# "up" only recreates containers whose compose definition changed: apply changed config files as well
# (HUP is sent from inside the container: "docker kill", even with HUP, marks a container as manually stopped,
# and restart: unless-stopped then leaves it down after the next boot)
if grep -q ' blackbox/' <<<"$changed"; then compose exec -T blackbox-exporter kill -HUP 1 >/dev/null && echo "reload:  blackbox-exporter"; fi
if grep -q ' alloy/' <<<"$changed"; then compose exec -T alloy kill -HUP 1 >/dev/null && echo "reload:  alloy"; fi

# 6. nothing may listen beyond loopback, except the exporters and Alloy on the CT address (behind the firewall above)
sleep 15
ports='3000|3100|9091|9096|9100|9113|9115|12345'
if ss -H -ltn | awk '{print $4}' | grep -E ":($ports)\$" | grep -vE '^(127\.0\.0\.1|\[::1\]):' | grep -vxE '10\.10\.10\.26:(9100|9113|9115|12345)'; then
  echo "ERROR: a monitoring port listens beyond loopback (see above); stopping the stack" >&2
  compose down
  exit 1
fi
compose ps --format 'table {{.Service}}\t{{.Status}}'
echo "Grafana: https://grafana.lab.guilhermefilho.com (CT 108, via NPM)"
