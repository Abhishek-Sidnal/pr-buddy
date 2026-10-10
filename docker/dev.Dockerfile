# Development image: runs the repository's npm scripts as an unprivileged user.
FROM node:24-alpine

RUN mkdir -p /workspace/node_modules && chown -R node:node /workspace

WORKDIR /workspace
USER node

CMD ["npm", "run", "check"]
