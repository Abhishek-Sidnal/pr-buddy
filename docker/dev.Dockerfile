# Development image: runs the repository's npm scripts as an unprivileged user.
FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5

RUN mkdir -p /workspace/node_modules && chown -R node:node /workspace

WORKDIR /workspace
USER node

CMD ["npm", "run", "check"]
