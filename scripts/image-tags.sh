#!/bin/sh
# Prints the names the API image is published under for a git ref, one per line.
#
#   sh scripts/image-tags.sh refs/heads/main Owner/Repo     ghcr.io/owner/repo-api:edge
#   sh scripts/image-tags.sh refs/tags/v1.2.3 Owner/Repo    ghcr.io/owner/repo-api:1.2.3 and :latest
#
# A pre-release such as v1.2.3-rc.1 gets its version only: `latest` always means a release.
# Any other ref is refused, so that nothing is ever published from a branch or a stray tag.
# See docs/BRAIN.md, D-082.
set -eu

ref=${1:?usage: image-tags.sh <git ref> <owner/repository>}
repository=${2:?usage: image-tags.sh <git ref> <owner/repository>}

if ! printf '%s\n' "$repository" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "Not a repository name: $repository" >&2
  exit 1
fi
# A registry accepts lower-case names only.
image="ghcr.io/$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')-api"

case "$ref" in
  refs/heads/main)
    echo "$image:edge"
    ;;
  refs/tags/v*)
    version=${ref#refs/tags/v}
    if printf '%s\n' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "$image:$version"
      echo "$image:latest"
    elif printf '%s\n' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.]+$'; then
      echo "$image:$version"
    else
      echo "Not a version tag: $ref" >&2
      exit 1
    fi
    ;;
  *)
    echo "Nothing is published for $ref" >&2
    exit 1
    ;;
esac
