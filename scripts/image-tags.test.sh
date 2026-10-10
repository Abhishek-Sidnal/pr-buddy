#!/bin/sh
# Checks scripts/image-tags.sh. Run from the repository root: sh scripts/image-tags.test.sh
set -eu

status=0

# expect <ref> <repository> <expected output, names separated by spaces; "refused" for an error>
expect() {
  if actual=$(sh scripts/image-tags.sh "$1" "$2" 2>/dev/null); then
    actual=$(printf '%s' "$actual" | tr '\n' ' ')
  else
    actual=refused
  fi
  if [ "$actual" != "$3" ]; then
    echo "FAILED: $1 $2"
    echo "  expected: $3"
    echo "  actual:   $actual"
    status=1
  fi
}

image=ghcr.io/acme/pr-buddy-api

expect refs/heads/main Acme/PR-Buddy "$image:edge"
expect refs/tags/v1.2.3 Acme/PR-Buddy "$image:1.2.3 $image:latest"
expect refs/tags/v0.10.0 acme/pr-buddy "$image:0.10.0 $image:latest"
expect refs/tags/v1.2.3-rc.1 acme/pr-buddy "$image:1.2.3-rc.1"

expect refs/heads/feature acme/pr-buddy refused
expect refs/heads/main-2 acme/pr-buddy refused
expect refs/pull/7/merge acme/pr-buddy refused
expect refs/tags/latest acme/pr-buddy refused
expect refs/tags/v1.2 acme/pr-buddy refused
expect refs/tags/v1.2.3.4 acme/pr-buddy refused
expect refs/tags/vnext acme/pr-buddy refused
expect "refs/tags/v1.2.3 --tag evil" acme/pr-buddy refused
expect 'refs/tags/v1.2.3-$(id)' acme/pr-buddy refused
expect refs/tags/v1.2.3/x acme/pr-buddy refused
expect refs/heads/main "acme/pr-buddy evil" refused
expect refs/heads/main "acme/pr-buddy/extra" refused
expect refs/heads/main acme refused

if [ "$status" -eq 0 ]; then
  echo "image-tags.sh behaves as expected."
fi
exit "$status"
