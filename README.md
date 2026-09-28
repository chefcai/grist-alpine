# grist-alpine

A smaller, Alpine Linux–based container image for [Grist](https://github.com/gristlabs/grist-core), the open-source relational spreadsheet. It's built for small, resource-limited hosts.

The image is built from an unmodified upstream `grist-core` release tag by GitHub Actions and published to `ghcr.io/chefcai/grist-alpine`.

## How it differs from `gristlabs/grist-oss`

| | Upstream (`grist-oss`) | `grist-alpine` |
|---|---|---|
| Base | Debian (trixie-slim) | Alpine |
| Python (formula engine) | 3.11 | 3.11 (musl build) |
| Formula sandbox | gVisor (default), Pyodide (optional) | gVisor only |
| Built web assets | Copied twice (duplicate layer) | Copied once |
| Python stdlib extras (tests, tkinter, idle, pip) | Included | Removed |
| Browser-only npm packages in runtime `node_modules` | Included | Removed (already bundled into `static/`) |

It uses the same Grist community edition code, the same environment variables and the same `/persist` data layout as upstream. Existing volumes work unchanged, and the container user is still `grist` (uid/gid 1001).

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
- `<version>` (e.g. `1.7.19`): a specific `grist-core` release

A scheduled workflow checks daily for new upstream releases and rebuilds weekly to pick up Alpine security updates.

## Building locally

```bash
git clone --depth 1 --branch v1.7.19 https://github.com/gristlabs/grist-core.git src
docker build -t grist-alpine:local .
./tests/smoke.sh grist-alpine:local
```

The build context is this repository, with the upstream source in `./src`.
`tools/find-client-only-deps.js` runs during the build and removes only npm
packages that nothing outside `app/client` references (directly, dynamically by
name, or through another kept package). It prints what it removed.

## License

Apache-2.0, the same as grist-core. Grist is developed by Grist Labs; this repository only contains the build recipe. See [NOTICE](NOTICE).
