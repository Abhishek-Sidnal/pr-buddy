# Production image for the PR Buddy API. Build from the repository root:
#   docker build -f docker/api.Dockerfile -t pr-buddy-api .

FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
WORKDIR /app

# Manifests first, so the dependency layer is reused until they change.
COPY package.json package-lock.json ./
COPY packages/review-engine/package.json packages/review-engine/
COPY packages/ai-reviewer/package.json packages/ai-reviewer/
COPY packages/github-client/package.json packages/github-client/
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev


FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
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
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/migrations apps/api/migrations
# The dashboard, as static files the API serves. Its sources and build tools stay behind.
COPY --from=build /app/apps/web/dist apps/web/dist

# The service needs no write access and no privileges.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
