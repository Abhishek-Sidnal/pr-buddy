# Development image: runs the repository's npm scripts as an unprivileged user.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4

RUN mkdir -p /workspace/node_modules && chown -R node:node /workspace

WORKDIR /workspace
USER node

CMD ["npm", "run", "check"]
