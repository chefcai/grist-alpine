# grist-alpine

A smaller, Alpine Linux–based container image for [Grist](https://github.com/gristlabs/grist-core), the open-source relational spreadsheet. It's built for small, resource-limited hosts.

The image is built from an unmodified upstream `grist-core` release tag by GitHub Actions and published to `ghcr.io/chefcai/grist-alpine`.

## How it differs from `gristlabs/grist-oss`

| | Upstream (`grist-oss`) | `grist-alpine` |
|---|---|---|
| Base | Debian (trixie-slim) | Alpine 3.22 |
| Node.js 22 | Official Node image (with npm, yarn, corepack, headers) | Alpine's `nodejs` package only |
| Python (formula engine) | 3.11 | 3.11 (musl build) |
| Formula sandbox | gVisor (default), Pyodide (optional) | gVisor only |
| Built web assets | Copied twice (duplicate layer) | Copied once |
| Locale data (ICU) | Full | Full (`icu-data-full`) |
| Python stdlib extras (tests, tkinter, idle, pip, setuptools, self-test modules) | Included | Removed |
| Browser-only npm packages in runtime `node_modules` | Included | Removed (already bundled into `static/`) |
| Browser, UMD, minified and ES-module copies inside server packages | Included | Removed (reviewed list, re-checked at build time) |
| Tests, docs, examples, C sources, source maps and type declarations inside packages | Included | Removed |

It uses the same Grist community edition code, the same environment variables and the same `/persist` data layout as upstream. Existing volumes work unchanged, and the container user is still `grist` (uid/gid 1001).

Alpine 3.22 is used because it is the newest Alpine release whose `nodejs` package is Node 22, the version grist-core targets. The base will move forward when grist-core moves to a newer Node LTS.

**Not included:** the optional Pyodide sandbox. If you set `GRIST_SANDBOX_FLAVOR=pyodide`, use the upstream image instead.

## Usage

```bash
cp .env.example .env        # adjust values
docker compose -f docker-compose.example.yml up -d
```

Then open `http://localhost:8484` (or the port you set in `.env`).

All of Grist's own settings are regular environment variables; see the upstream
[self-hosting docs](https://support.getgrist.com/self-managed/).

### Storage note

Grist documents are SQLite files. Keep `/persist` on local disk. Network filesystems such as NFS or SMB can break SQLite file locking and corrupt documents. Back the directory up to network storage instead.

## Tags

- `latest`: the most recent upstream release
- `<version>` (e.g. `1.7.20`): a specific `grist-core` release

A scheduled workflow checks daily for new upstream releases and rebuilds weekly to pick up Alpine security updates.

## Building locally

```bash
git clone --depth 1 --branch v1.7.20 https://github.com/gristlabs/grist-core.git src
docker build -t grist-alpine:local .
./tests/smoke.sh grist-alpine:local
python3 tests/functional.py grist-alpine:local   # DOCKER=podman for Podman
```

The build context is this repository, with the upstream source in `./src`.

`tools/find-client-only-deps.js` runs during the build. It removes npm packages
that nothing server-side references (directly, dynamically by name, or through
another kept package) and keeps only the served files of packages that browsers
load through `static/` links. It also removes the reviewed bundle copies in its
`TRIM` table. Each entry is re-checked on every build, and the build fails if
anything still points at a removed path. Every trimmed package must still load
afterwards. The Python stage fails the same way if the formula engine imports a
removed module.

`tests/functional.py` starts the image with the gVisor sandbox and checks:

- documents, formulas, records, imports and exports, and attachments
- API keys, document history, and locale formatting
- that every script and stylesheet on the main pages loads
- persistence across a restart

CI runs it before publishing.

## License

Apache-2.0, the same as grist-core. Grist is developed by Grist Labs; this repository only contains the build recipe. See [NOTICE](NOTICE).
