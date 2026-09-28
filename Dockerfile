# syntax=docker/dockerfile:1
################################################################################
## grist-alpine: a slimmer, Alpine-based build of Grist (grist-core).
##
## Build context is this repository, with a checkout of
## https://github.com/gristlabs/grist-core at the tag you want in ./src, e.g.:
##   git clone --depth 1 --branch v1.7.19 https://github.com/gristlabs/grist-core.git src
##   docker build -t grist-alpine:local .
##
## Differences from the upstream image:
##   - Alpine (musl) base instead of Debian.
##   - Pyodide sandbox omitted (gVisor remains the default formula sandbox).
##   - Built static assets copied once (no duplicate layer).
##   - Unused parts of the Python stdlib removed (test suite, tkinter, idle, pip).
##   - Browser-only npm packages (already bundled into static/ by webpack) are
##     removed from the runtime node_modules; see tools/find-client-only-deps.js.
################################################################################

ARG ALPINE_VERSION=3.24
ARG NODE_VERSION=22
ARG PYTHON_VERSION=3.11

################################################################################
## Shared Node base with native build tooling (for the sqlite3 addon)
################################################################################
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node-base
RUN apk add --no-cache bash git python3 make g++
WORKDIR /grist
# Community edition only: never download extensions during install.
ENV GRIST_SKIP_EXT_AUTOSETUP=1

################################################################################
## Production node_modules only
################################################################################
FROM node-base AS prod-deps
COPY src/package.json src/yarn.lock /grist/
COPY src/buildtools/install_edition.sh /grist/buildtools/install_edition.sh
RUN yarn install --prod --frozen-lockfile --network-timeout 600000 \
 && yarn cache clean \
 && find /grist/node_modules -type d -path '*/build/Release/obj*' -prune -exec rm -rf {} + \
 && find /grist/node_modules -type d -name '.deps' -prune -exec rm -rf {} +

################################################################################
## Full build (dev dependencies + webpack/tsc)
################################################################################
FROM node-base AS builder
COPY src/package.json src/yarn.lock /grist/
COPY src/buildtools/install_edition.sh /grist/buildtools/install_edition.sh
RUN yarn install --frozen-lockfile --network-timeout 600000
RUN mkdir -p /node_modules /grist/ext
COPY src/tsconfig.json src/tsconfig-ext.json src/tsconfig-prod.json /grist/
COPY src/test/tsconfig.json /grist/test/tsconfig.json
COPY src/test/chai-as-promised.js /grist/test/chai-as-promised.js
COPY src/app /grist/app
COPY src/stubs /grist/stubs
COPY src/buildtools /grist/buildtools
COPY src/static/locales /grist/static/locales
ARG GRIST_BUILD_CHANNEL=
ARG GRIST_BUILD_COMMIT=
RUN GRIST_BUILD_CHANNEL=${GRIST_BUILD_CHANNEL} GRIST_BUILD_COMMIT=${GRIST_BUILD_COMMIT} \
    WEBPACK_EXTRA_MODULE_PATHS=/node_modules yarn run build:prod \
 && rm -rf /grist/static/locales

################################################################################
## Prune browser-only packages from the production node_modules
################################################################################
FROM prod-deps AS pruned
COPY --from=builder /grist/_build /grist/_build
COPY src/sandbox /grist/sandbox
COPY src/bower_components /grist/bower_components
COPY src/static /grist/static
COPY --from=builder /grist/static /grist/static
COPY tools/find-client-only-deps.js /tmp/find-client-only-deps.js
RUN node /tmp/find-client-only-deps.js /grist \
 && node /tmp/find-client-only-deps.js /grist --names > /tmp/prune-list \
 && cd /grist/node_modules && xargs -r rm -rf < /tmp/prune-list

################################################################################
## Python for the formula engine (same minor version as upstream, musl build)
################################################################################
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS python
COPY src/sandbox/requirements.txt /tmp/requirements.txt
RUN apk add --no-cache --virtual .build-deps build-base \
 && pip3 install --no-cache-dir -r /tmp/requirements.txt \
 && apk del .build-deps \
 && cd /usr/local/lib/python3.11 \
 && rm -rf test idlelib tkinter turtledemo ensurepip site-packages/pip site-packages/pip-*

################################################################################
## gVisor runsc (static binary), same source as upstream
################################################################################
FROM docker.io/gristlabs/gvisor-unprivileged:buster AS sandbox

################################################################################
## Runtime
################################################################################
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION}

ARG GRIST_ALLOW_AUTOMATIC_VERSION_CHECKING=false

# bash/setpriv/tini: entrypoint; curl: healthchecks; procps-ng: gVisor process mgmt;
# remaining libs: runtime deps of the copied CPython build.
RUN apk add --no-cache \
      bash curl tini setpriv procps-ng \
      libffi libbz2 xz-libs zlib sqlite-libs expat ncurses-libs readline gdbm libuuid libssl3 libcrypto3 \
 && ln -sf /sbin/tini /usr/bin/tini \
 && mkdir -p /persist/docs \
 && addgroup -g 1001 grist \
 && adduser -D -u 1001 -G grist -s /bin/bash grist

# Node app
COPY --from=pruned /grist/node_modules /grist/node_modules
COPY --from=builder /grist/_build /grist/_build
COPY --from=builder /grist/app/cli.sh /grist/cli

# Python
COPY --from=python /usr/local/bin/python3.11 /usr/bin/python3.11
COPY --from=python /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=python /usr/local/lib/libpython3.11.so.1.0 /usr/local/lib/
RUN ln -s python3.11 /usr/bin/python3 && ln -s python3.11 /usr/bin/python

# gVisor
COPY --from=sandbox /runsc /usr/bin/runsc

# Server files; built static assets are merged over the source static dir.
COPY src/package.json /grist/package.json
COPY src/bower_components /grist/bower_components
COPY src/sandbox /grist/sandbox
COPY src/plugins /grist/plugins
COPY src/static /grist/static
COPY --from=builder /grist/static /grist/static

ENV GRIST_DOCKER_USER=grist \
    GRIST_DOCKER_GROUP=grist
WORKDIR /grist

ENV \
  GRIST_ORG_IN_PATH=true \
  GRIST_HOST=0.0.0.0 \
  GRIST_SERVE_SAME_ORIGIN=true \
  GRIST_DATA_DIR=/persist/docs \
  GRIST_INST_DIR=/persist \
  GRIST_SESSION_COOKIE=grist_core \
  GRIST_ALLOW_AUTOMATIC_VERSION_CHECKING=${GRIST_ALLOW_AUTOMATIC_VERSION_CHECKING} \
  GVISOR_FLAGS="-unprivileged -ignore-cgroups" \
  NODE_OPTIONS="--no-deprecation --disable-proto=delete" \
  NODE_ENV=production \
  TYPEORM_DATABASE=/persist/home.sqlite3

EXPOSE 8484

ENTRYPOINT ["./sandbox/docker_entrypoint.sh"]
CMD ["./sandbox/run.sh"]
