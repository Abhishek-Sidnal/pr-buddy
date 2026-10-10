#!/bin/sh
# Backs up the database of the example stack: dump, check, copy to a bucket, tidy up.
#
#   deploy/backup.sh
#
# Run it every night from cron (deploy/crontab.example). It exits with an error, and sends an
# alert, when no usable backup was stored.
#
# The dump holds the review history and installations' AI keys in their encrypted form. It
# does NOT hold deploy/.env, where the key that decrypts them lives: keep a copy of that file
# somewhere else yourself. Guide: docs/DEPLOYMENT.md, section 6.
set -eu

# shellcheck source=deploy/ops-lib.sh
. "$(dirname -- "$0")/ops-lib.sh"

KEEP_LOCAL_DAYS=7
UPLOAD_TIMEOUT_SECONDS=900

umask 077
mkdir -p "$backup_dir"

name="prbuddy-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$backup_dir/.$name.partial"

fail() {
  rm -f "$partial"
  echo "Backup failed: $1" >&2
  notify "PR Buddy backup failed on $site" \
    "The nightly backup of $site failed: $1. No new backup was stored."
  exit 1
}

compose exec -T postgres pg_dump --username prbuddy --dbname prbuddy --format custom \
  > "$partial" || fail "the database could not be dumped"

[ -s "$partial" ] || fail "the dump is empty"

# A dump that cannot be listed cannot be restored. Better to know tonight.
compose exec -T postgres pg_restore --list < "$partial" > /dev/null ||
  fail "the dump cannot be read back"

mv "$partial" "$backup_dir/$name"
size=$(wc -c < "$backup_dir/$name" | tr -d ' ')

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  region=${BACKUP_S3_REGION:?set BACKUP_S3_REGION in deploy/ops.env}
  signed_curl s3 "$region" --max-time "$UPLOAD_TIMEOUT_SECONDS" --output /dev/null \
    --header "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
    --upload-file "$backup_dir/$name" \
    "https://$BACKUP_S3_BUCKET.s3.$region.amazonaws.com/${BACKUP_S3_PREFIX:-}$name" ||
    fail "the copy to the bucket failed; the dump is still in $backup_dir"
  where="here and in the bucket"
else
  where="on this machine only"
fi

find "$backup_dir" -name 'prbuddy-*.dump' -mtime "+$KEEP_LOCAL_DAYS" -delete

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Backup stored $where: $name, $size bytes."
