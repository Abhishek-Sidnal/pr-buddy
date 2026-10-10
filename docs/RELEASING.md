# Releasing PR Buddy

How a release is made, so that the next one is made the same way. A release is a tag on `main`
with a changelog entry and evidence that the checks passed on exactly that commit.

## 1. Before the release

| Step                                                                                      | Why                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `main` is green in CI and has no open pull request meant for this release                 | The tag must name a commit that passed                  |
| `docs/TRACKER.md` says what is done, what is not, and what was verified live              | Release notes are written from it                       |
| `CHANGELOG.md` has an entry for the version, with "Verified, and not" and "Upgrade notes" | A reader must learn the limits without reading the code |
| The version in every `package.json` is the release version                                | The packages are released together                      |
| A change to settings, the database or defaults is listed under "Upgrade notes"            | Retention, for example, deletes data on first start     |

## 2. The clean-checkout check

CI proves that a pull request passes. This step proves that the committed files alone, with
nothing from a working directory, install and pass on the runtime the image uses.

```bash
docker compose up -d postgres
git archive --format=tar HEAD | docker run --rm -i \
  --network prbuddy_default \
  -e TEST_DATABASE_URL=postgres://prbuddy:prbuddy@postgres:5432/prbuddy \
  node:24-alpine \
  sh -c 'mkdir /release && cd /release && tar -x && npm ci && npm run check \
         && npm audit --omit=dev && npm audit signatures && sh scripts/check-pins.sh' \
  2>&1 | tee release-check.log
```

`git archive` exports only what is committed, so untracked files, `node_modules` and build
output cannot help the run. Keep `release-check.log`: it is attached to the release.

Record in the tracker's "Latest verified check" the date, the commit and the result.

## 3. Tag and publish

```bash
git checkout main && git pull --ff-only
git tag -a v0.1.0 -m "PR Buddy 0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "PR Buddy 0.1.0" --notes-file <notes> release-check.log
```

The notes are the changelog entry for the version. The tag is annotated and is never moved: a
mistake is fixed by a new version.

Pushing the tag starts the "Publish image" workflow, which pushes the API image to GitHub's
container registry under the version and `latest` (D-082). When it has finished, copy the
digest from the run's summary into the release notes: it is what operators deploy.

## 4. After the release

- Check that the "Publish image" run for the tag succeeded and that its digest is in the notes.
- Start the next entry in `CHANGELOG.md` under "Unreleased" with the first change that follows.
- Move what the release left open into the tracker's backlog.

## What a release does not include

No package is published to npm. The image is not signed and has no provenance attestation.
People run PR Buddy by pulling the published image or by building it from the tagged source
([DEPLOYMENT.md](DEPLOYMENT.md), section 3).
