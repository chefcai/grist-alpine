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
##   - Node comes from Alpine's own nodejs package (no npm/yarn/corepack/headers
##     in the runtime image), and source maps / type declarations are stripped.
################################################################################

# Alpine 3.22 is the newest release whose "nodejs" package is Node 22 LTS, the
# version grist-core targets (.nvmrc). Every stage uses the same Alpine release
# so the copied CPython build and the compiled sqlite3 addon match the runtime.
ARG ALPINE_VERSION=3.22
ARG PYTHON_VERSION=3.11

################################################################################
## Shared Node base with native build tooling (for the sqlite3 addon)
################################################################################
FROM alpine:${ALPINE_VERSION} AS node-base
RUN apk add --no-cache nodejs nodejs-dev yarn bash git python3 make g++
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
 && rm -rf /grist/static/locales \
 && find /grist/static /grist/_build -type f -name '*.map' -delete

################################################################################
## Prune the runtime node_modules and _build
################################################################################
FROM prod-deps AS pruned
COPY --from=builder /grist/_build /grist/_build
COPY src/sandbox /grist/sandbox
COPY src/bower_components /grist/bower_components
COPY src/static /grist/static
COPY tools/find-client-only-deps.js /tmp/find-client-only-deps.js
# 1. Remove packages nothing server-side (or bower_components) references.
#    Packages reachable only through a served symlink keep just the linked files.
# 2. Remove the reviewed browser/minified bundles listed in the script's TRIM
#    table (each re-checked; the build fails if anything names one), then
#    non-runtime folders (tests, fixtures, docs, examples...) and Markdown
#    inside the kept packages (license files are kept). The trimmed packages
#    must still load.
# 3. Remove source maps / type declarations, glibc builds of native add-ons
#    (the image is musl), and debug info from native add-ons.
# 4. Remove the compiled browser code from _build (webpack bundles in static/
#    are what browsers load; no server file requires app/client).
RUN apk add --no-cache grep \
 && node /tmp/find-client-only-deps.js /grist \
 && node /tmp/find-client-only-deps.js /grist --names > /tmp/prune-list \
 && (cd /grist/node_modules && xargs -r rm -rf < /tmp/prune-list) \
 && node /tmp/find-client-only-deps.js /grist --asset-trim0 > /tmp/asset-trim \
 && xargs -0 -r rm -f < /tmp/asset-trim \
 && node /tmp/find-client-only-deps.js /grist --trim0 > /tmp/trim \
 && xargs -0 -r rm -rf < /tmp/trim \
 && node /tmp/find-client-only-deps.js /grist --junk0 > /tmp/junk \
 && xargs -0 -r rm -rf < /tmp/junk \
 && node /tmp/find-client-only-deps.js /grist --require-reviewed \
 && find /grist/node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 && find /grist/node_modules -type f -name '*glibc*.node' -delete \
 && find /grist/node_modules -mindepth 1 -maxdepth 2 -type d -name '*-linux-*-gnu*' -prune -exec rm -rf {} + \
 && find /grist/node_modules -type f -name '*.node' -exec strip --strip-unneeded {} + \
 && ! grep -rlE "require\\(\"(\\.\\./)+client/|\"app/client/" /grist/_build --include='*.js' --exclude-dir=client \
 && rm -rf /grist/_build/app/client

################################################################################
## Python for the formula engine (same minor version as upstream, musl build)
################################################################################
FROM python:${PYTHON_VERSION}-alpine${ALPINE_VERSION} AS python
COPY src/sandbox/requirements.txt /tmp/requirements.txt
COPY src/sandbox/grist /tmp/engine
# Unused by the formula engine and its requirements: packaging tools, the
# interactive-docs data, 2to3 and venv, CPython's self-test extension modules,
# and the Tk, curses-panel, GNU dbm and NIS bindings (whose libraries are not
# installed). The check fails the build if anything in the engine or its
# installed packages imports them. One known, safe exception:
# wrapt/importer.py imports pkg_resources inside try/except ImportError (an
# optional entry-point discovery that becomes a no-op).
# Translation sources (.po/.pot) are removed too: gettext loads only the compiled
# .mo files, which are kept; the build fails if any code names a .po/.pot file.
# One known, safe exception: friendly_traceback/__init__.py skips "*.pot" when
# listing its language folders.
RUN apk add --no-cache --virtual .build-deps build-base \
 && pip3 install --no-cache-dir -r /tmp/requirements.txt \
 && apk del .build-deps \
 && cd /usr/local/lib/python3.11 \
 && python3 -c "import re,sys,pathlib; pat=re.compile(r'^[ \t]*(import|from)[ \t]+(setuptools|pkg_resources|lib2to3|pydoc_data|venv|_testcapi|_testbuffer|_testinternalcapi|_testmultiphase|_testimportmultiple|_testclinic|_ctypes_test|_xxtestfuzz|xxlimited|xxlimited_35|_tkinter|_curses_panel|curses\.panel|_gdbm|_dbm|dbm\.gnu|dbm\.ndbm|nis)\b', re.M); skip={'setuptools','pkg_resources','_distutils_hack','pip','wheel'}; allow={'site-packages/wrapt/importer.py'}; hits=[str(p) for b in sys.argv[1:] for p in pathlib.Path(b).rglob('*.py') if not skip & set(p.parts) and str(p) not in allow and pat.search(p.read_text(errors='ignore'))]; print('uses removed modules:', hits); sys.exit(1 if hits else 0)" /tmp/engine site-packages \
 && rm -rf test idlelib tkinter turtledemo ensurepip lib2to3 pydoc_data venv \
      site-packages/pip site-packages/pip-* site-packages/setuptools site-packages/setuptools-* \
      site-packages/wheel site-packages/wheel-* \
      site-packages/pkg_resources site-packages/_distutils_hack site-packages/distutils-precedence.pth \
 && rm -f lib-dynload/_test*.so lib-dynload/_ctypes_test*.so lib-dynload/_xxtestfuzz*.so lib-dynload/xxlimited*.so \
      lib-dynload/_tkinter*.so lib-dynload/_curses_panel*.so lib-dynload/_gdbm*.so lib-dynload/_dbm*.so lib-dynload/nis*.so \
 && python3 -c "import re,sys,pathlib; pat=re.compile(r'''\.pot?['\"]'''); allow={'site-packages/friendly_traceback/__init__.py'}; hits=[str(p) for b in sys.argv[1:] for p in pathlib.Path(b).rglob('*.py') if str(p) not in allow and pat.search(p.read_text(errors='ignore'))]; print('reads .po/.pot files:', hits); sys.exit(1 if hits else 0)" /tmp/engine site-packages \
 && find site-packages \( -name '*.po' -o -name '*.pot' \) -delete \
 && rm -rf /tmp/engine

################################################################################
## gVisor runsc (static binary), same source as upstream
################################################################################
FROM docker.io/gristlabs/gvisor-unprivileged:buster AS sandbox

################################################################################
## Runtime
################################################################################
FROM alpine:${ALPINE_VERSION}

ARG GRIST_ALLOW_AUTOMATIC_VERSION_CHECKING=false

# nodejs + icu-data-full: server runtime with full locale data (Alpine otherwise
# installs English-only ICU data); bash/setpriv/tini: entrypoint; curl: healthchecks; procps-ng: gVisor process mgmt;
# remaining libs: runtime deps of the copied CPython build.
RUN apk add --no-cache \
      nodejs icu-data-full bash curl tini setpriv procps-ng \
      libffi libbz2 xz-libs zlib sqlite-libs expat readline libuuid libssl3 libcrypto3 \
 && ln -sf /sbin/tini /usr/bin/tini \
 && mkdir -p /persist/docs \
 && addgroup -g 1001 grist \
 && adduser -D -u 1001 -G grist -s /bin/bash grist

# Node app
COPY --from=pruned /grist/node_modules /grist/node_modules
COPY --from=pruned /grist/_build /grist/_build
COPY --from=builder /grist/app/cli.sh /grist/cli

# Python
COPY --from=python /usr/local/bin/python3.11 /usr/bin/python3.11
COPY --from=python /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=python /usr/local/lib/libpython3.11.so.1.0 /usr/local/lib/
# Every remaining extension module must load (catches a missing system library).
RUN ln -s python3.11 /usr/bin/python3 && ln -s python3.11 /usr/bin/python \
 && python3 -B -c "import importlib, pathlib; mods = sorted(p.name.split('.')[0] for p in pathlib.Path('/usr/local/lib/python3.11/lib-dynload').glob('*.so')); [importlib.import_module(m) for m in mods]; print(len(mods), 'extension modules load')"

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
