#!/bin/sh
# Fails when a GitHub Action or a container image is referenced by a tag alone.
#
# A tag can be moved to different content after it was reviewed; a commit or a digest cannot.
# Every action must be pinned to a full commit SHA and every image to a sha256 digest.
# Dependabot keeps the pins current. See docs/SECURITY.md, section 4.
set -eu

status=0

report() {
  echo "Not pinned: $1"
  status=1
}

# `uses:` must end in @<40 hexadecimal characters>, optionally followed by a comment.
unpinned_actions=$(grep -rnE '^\s*-?\s*uses:' .github/workflows \
  | grep -vE 'uses:\s*[^@ ]+@[0-9a-f]{40}(\s|$)' || true)
if [ -n "$unpinned_actions" ]; then
  report "$unpinned_actions"
fi

# `FROM` and `image:` must name a digest.
unpinned_images=$(grep -rnE '^\s*(FROM|image:)\s' \
  docker compose.yaml deploy/compose.yaml .github/workflows \
  | grep -vE '@sha256:[0-9a-f]{64}(\s|$)' || true)
if [ -n "$unpinned_images" ]; then
  report "$unpinned_images"
fi

if [ "$status" -eq 0 ]; then
  echo "Every action and image is pinned."
fi
exit "$status"
