# The image of PR Buddy's GitHub Action. GitHub builds it from the repository at the commit a
# workflow pins, so the code that runs is PR Buddy's own and never a pull request's.
#   docker build -f docker/runner.Dockerfile -t pr-buddy-runner .

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app

# Manifests first, so the dependency layer is reused until they change. Every workspace's
# manifest is needed for the lockfile to be accepted; only the runner's dependencies are installed.
COPY package.json package-lock.json ./
COPY packages/review-engine/package.json packages/review-engine/
COPY packages/ai-reviewer/package.json packages/ai-reviewer/
COPY packages/github-client/package.json packages/github-client/
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
RUN npm ci --include-workspace-root \
      --workspace @pr-buddy/review-engine \
      --workspace @pr-buddy/ai-reviewer \
      --workspace @pr-buddy/github-client \
      --workspace @pr-buddy/runner

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/runner apps/runner
RUN npm run build --workspace @pr-buddy/review-engine \
 && npm run build --workspace @pr-buddy/ai-reviewer \
 && npm run build --workspace @pr-buddy/github-client \
 && npm run build --workspace @pr-buddy/runner \
 && npm prune --omit=dev


FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/review-engine/package.json packages/review-engine/
COPY --from=build /app/packages/review-engine/dist packages/review-engine/dist
COPY --from=build /app/packages/ai-reviewer/package.json packages/ai-reviewer/
COPY --from=build /app/packages/ai-reviewer/dist packages/ai-reviewer/dist
COPY --from=build /app/packages/github-client/package.json packages/github-client/
COPY --from=build /app/packages/github-client/dist packages/github-client/dist
COPY --from=build /app/apps/runner/package.json apps/runner/
COPY --from=build /app/apps/runner/dist apps/runner/dist

# GitHub runs a container action as root, so that it can write the job's summary and outputs.
# The action reads the event and GitHub's API and executes nothing from the repository.
ENTRYPOINT ["node", "/app/apps/runner/dist/main.js"]
