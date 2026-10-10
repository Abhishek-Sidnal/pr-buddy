#!/bin/sh
# Checks the example stack and tells its operator when something is wrong, and when it is
# right again.
#
#   deploy/watch.sh          check; alert if the set of problems changed since last time
#   deploy/watch.sh --print  check and print; send nothing and remember nothing
#
# Run it every five minutes from cron (deploy/crontab.example). It exits 1 while there is a
# problem. It runs on the machine it watches: a machine that is down says nothing, so have an
# alarm outside it as well. Guide: docs/DEPLOYMENT.md, section 7.
set -eu

# shellcheck source=deploy/ops-lib.sh
. "$(dirname -- "$0")/ops-lib.sh"

CERTIFICATE_MIN_DAYS=14
DISK_MAX_PERCENT=85
BACKUP_MAX_AGE_MINUTES=1560 # 26 hours: one missed night
FAILED_REVIEWS_WINDOW_MINUTES=30
FAILED_REVIEWS_MAX=3
REQUEST_TIMEOUT_SECONDS=15

print_only=false
[ "${1:-}" = "--print" ] && print_only=true

# What is asked to see whether the service works. It can be replaced to rehearse an outage.
url=${WATCH_URL:-https://$site/readyz}

problems=""
keys=""
# problem <key> <what to tell the operator>. The key says which problem it is; the text may
# carry numbers that move while the problem stays the same.
problem() {
  keys="$keys$1
"
  problems="$problems$2
"
}

# --- Reachable: through the public address, as a visitor or GitHub would arrive.
status=$(curl --silent --output /dev/null --max-time "$REQUEST_TIMEOUT_SECONDS" \
  --write-out '%{http_code}' "$url" || true)
is_reachable=true
if [ "$status" != "200" ]; then
  is_reachable=false
  problem unreachable "the service did not answer over its public address"
fi

# --- Containers.
running=$(compose ps --status running --services 2> /dev/null || true)
for service in proxy api postgres; do
  printf '%s\n' "$running" | grep -qx "$service" ||
    problem "container-$service" "the $service container is not running"
done

# --- Certificate. Caddy renews it a month ahead, so this close to the end means renewal fails.
if [ "$is_reachable" = true ] && [ -z "${WATCH_URL:-}" ]; then
  if ! echo | openssl s_client -servername "$site" -connect "$site:443" 2> /dev/null |
    openssl x509 -noout -checkend $((CERTIFICATE_MIN_DAYS * 86400)) > /dev/null 2>&1; then
    problem certificate "the certificate expires within $CERTIFICATE_MIN_DAYS days"
  fi
fi

# --- Disk.
used=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }')
if [ "${used:-0}" -gt "$DISK_MAX_PERCENT" ]; then
  problem disk "the root file system is $used% full"
fi

# --- Backup, when backups are expected here.
if [ -n "${BACKUP_S3_BUCKET:-}" ] || [ "${BACKUP_EXPECTED:-}" = "1" ]; then
  fresh=$(find "$backup_dir" -name 'prbuddy-*.dump' -mmin "-$BACKUP_MAX_AGE_MINUTES" 2> /dev/null |
    head -n 1)
  [ -n "$fresh" ] || problem backup "the newest backup is older than 26 hours"
fi

# --- Failed reviews. A count only: nothing about which repository.
failed=$(compose exec -T postgres psql --username prbuddy --dbname prbuddy --tuples-only \
  --no-align --command "SELECT count(*) FROM reviews WHERE status = 'failed' AND started_at > now() - interval '$FAILED_REVIEWS_WINDOW_MINUTES minutes'" \
  2> /dev/null | tr -d '[:space:]' || true)
case "$failed" in
  '' | *[!0-9]*) ;; # The database did not answer; the container check has said so.
  *)
    if [ "$failed" -ge "$FAILED_REVIEWS_MAX" ]; then
      problem reviews "$failed reviews failed in the last $FAILED_REVIEWS_WINDOW_MINUTES minutes"
    fi
    ;;
esac

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$print_only" = true ]; then
  if [ -z "$problems" ]; then
    echo "$now $site: no problem found."
    exit 0
  fi
  printf '%s %s: problems found:\n%s' "$now" "$site" "$problems"
  exit 1
fi

# --- Tell someone, but only when what is wrong has changed: the set of keys, not the wording.
mkdir -p "$state_dir"
state_file="$state_dir/watch.problems"
current=$(printf '%s' "$keys" | sort -u)
previous=$(cat "$state_file" 2> /dev/null || true)

if [ "$current" != "$previous" ]; then
  if [ -z "$problems" ]; then
    echo "$now $site: recovered."
    notify "PR Buddy recovered on $site" "Every check on $site passes again."
  else
    printf '%s %s: problems found:\n%s' "$now" "$site" "$problems"
    notify "PR Buddy problem on $site" "Checks failing on $site:
$problems"
  fi
  printf '%s\n' "$current" > "$state_file.new"
  mv "$state_file.new" "$state_file"
fi

[ -z "$problems" ]
