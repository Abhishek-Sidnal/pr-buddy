#!/bin/sh
# Shared by backup.sh and watch.sh. Not run on its own: it is read with ".".
# Guide: docs/DEPLOYMENT.md, sections 6 and 7. Design: docs/DESIGN-OPERATIONS.md.

# The folder this file is in, and the folder that holds it.
deploy_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root_dir=$(dirname -- "$deploy_dir")

if [ ! -f "$deploy_dir/.env" ]; then
  echo "No $deploy_dir/.env: the stack is not configured here." >&2
  exit 2
fi

# Settings for backups and alerts. Optional: without it, backups stay on this machine and
# problems are only printed.
if [ -f "$deploy_dir/ops.env" ]; then
  # shellcheck disable=SC1091
  . "$deploy_dir/ops.env"
fi

state_dir=${OPS_STATE_DIR:-$root_dir/state}
backup_dir=${BACKUP_DIR:-$root_dir/backups}

# One value from deploy/.env. That file is not read as a whole: it holds secrets this script
# has no use for.
setting() {
  sed -n "s/^$1=//p" "$deploy_dir/.env" | head -n 1
}

site=$(setting SITE_ADDRESS)

# The stack, with the same files it was started with.
compose() {
  if [ -n "$(setting PR_BUDDY_IMAGE)" ]; then
    docker compose -f "$deploy_dir/compose.yaml" -f "$deploy_dir/compose.image.yaml" \
      --env-file "$deploy_dir/.env" "$@"
  else
    docker compose -f "$deploy_dir/compose.yaml" --env-file "$deploy_dir/.env" "$@"
  fi
}

# Runs curl with AWS request signing. The credential reaches curl on its standard input, so it
# never appears in the list of running processes.
#   signed_curl <service> <region> <curl arguments...>
signed_curl() {
  aws_service=$1
  aws_region=$2
  shift 2
  printf 'user = "%s:%s"\n' "${AWS_ACCESS_KEY_ID:-}" "${AWS_SECRET_ACCESS_KEY:-}" |
    curl --config - --silent --show-error --fail \
      --aws-sigv4 "aws:amz:$aws_region:$aws_service" "$@"
}

# Sends a message to whoever watches this deployment. A message names the site and what is
# wrong, and nothing else: no repository, no person, no secret.
#   notify <subject> <message>
notify() {
  notify_subject=$1
  notify_message=$2

  if [ -n "${ALERT_SNS_TOPIC_ARN:-}" ]; then
    sns_region=$(printf '%s' "$ALERT_SNS_TOPIC_ARN" | cut -d: -f4)
    signed_curl sns "$sns_region" --max-time 20 --output /dev/null \
      --data-urlencode "Action=Publish" \
      --data-urlencode "Version=2010-03-31" \
      --data-urlencode "TopicArn=$ALERT_SNS_TOPIC_ARN" \
      --data-urlencode "Subject=$notify_subject" \
      --data-urlencode "Message=$notify_message" \
      "https://sns.$sns_region.amazonaws.com/" ||
      echo "The alert could not be sent through SNS." >&2
  fi

  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    # The text is made here, from fixed words and the site's name. It is still escaped for JSON.
    notify_text=$(printf '%s: %s' "$notify_subject" "$notify_message" |
      sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')
    curl --silent --show-error --fail --max-time 20 --output /dev/null \
      --header 'content-type: application/json' \
      --data "{\"text\":\"$notify_text\"}" \
      "$ALERT_WEBHOOK_URL" ||
      echo "The alert could not be sent to the webhook." >&2
  fi
}
