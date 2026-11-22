# microrun

Self-hosted, safe release rollback for Docker Compose projects without Kubernetes.
One instance serves every environment of a project (dev, stage, production): it records each
release, checks the database schema before a deploy, rolls back in one click from the web UI
without running DDL, and refuses to redeploy a commit that was rolled back.

## Installation

The server ships as the Docker image [`pctea/microrun`](https://hub.docker.com/r/pctea/microrun) (tags `0.1.0`, `0.1`, `latest`).

```yaml
# docker-compose.yml
services:
  microrun:
    image: pctea/microrun:0.1
    restart: unless-stopped
    env_file: .env
    ports: ["8080:8080"]
    volumes:
      - microrun-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
volumes:
  microrun-data:
```

`.env`:

| Variable | Required | Value |
|---|---|---|
| `MICRORUN_ADMIN_USER` | yes | admin login |
| `MICRORUN_ADMIN_PASSWORD` | yes | admin password, at least 12 characters, or the server refuses to start |
| `MICRORUN_SECRET_KEY` | yes | 32 bytes in base64 (`openssl rand -base64 32`), encrypts storage secrets |
| `MICRORUN_PUBLIC_URL` | yes | external URL; `https://` turns on the `Secure` cookie flag |
| `MICRORUN_TRUST_PROXY` | no | off; comma-separated addresses or subnets of reverse proxies (`127.0.0.1`, `10.0.0.0/8`) whose `X-Forwarded-For`/`X-Forwarded-Proto` the server trusts |
| `MICRORUN_DATA_DIR` | no | `/data`; SQLite `microrun.db` in WAL mode |
| `PORT` | no | `8080` |

### HTTPS behind a reverse proxy

The server speaks plain HTTP; a proxy in front of it terminates TLS. Set `MICRORUN_TRUST_PROXY`
to the proxy address so the server sees the real client IP and protocol (the login rate limit
depends on it). The proxy must pass the WebSocket upgrade for `/api/v1/agent` and must not
buffer the SSE streams under `/ops` and `/api/v1/operations`.

Caddy:

```
microrun.example.com {
	reverse_proxy /ops/* 127.0.0.1:8080 {
		flush_interval -1
	}
	reverse_proxy /api/v1/operations/* 127.0.0.1:8080 {
		flush_interval -1
	}
	reverse_proxy 127.0.0.1:8080
}
```

Caddy passes the WebSocket upgrade and the `X-Forwarded-*` headers on its own.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name microrun.example.com;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location /api/v1/agent {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }

    location ~ ^/(ops|api/v1/operations)/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
    }
}
```

### Built-in agent

When `/var/run/docker.sock` is mounted, the server registers a server named `local` and manages
the containers of its own host. It needs:

- the compose project directories (an environment's `compose_dir`) mounted into the container
  **at the same path**: `-v /srv/shop:/srv/shop`;
- for private registries, `-v ~/.docker/config.json:/root/.docker/config.json:ro`;
- for local release storage, the `storage_path` directory mounted the same way.

### Agents on other servers

On every other host with Docker and Compose 2.30 or newer:

```sh
npm i -g microrun
MICRORUN_AGENT_TOKEN=<token from Settings → Servers> microrun agent --url https://microrun.example.com
```

The agent dials out to the server over a WebSocket; it needs no inbound ports and no SSH keys.
Pass the token through the environment rather than `--token`, so it does not show up in the
process list. With systemd:

```sh
sudo install -d -m 700 /etc/microrun
sudo install -m 600 /dev/null /etc/microrun/agent.env
echo 'MICRORUN_AGENT_TOKEN=<token>' | sudo tee /etc/microrun/agent.env >/dev/null
microrun agent install-service --url https://microrun.example.com | sudo tee /etc/systemd/system/microrun-agent.service
sudo systemctl enable --now microrun-agent
```

The unit printed by `install-service` reads the token through
`EnvironmentFile=/etc/microrun/agent.env` and never contains it, even when `--token` is given:
unit files are world-readable, so the token lives only in a file with mode 0600.

### Release storage

Give each server its own storage credentials, scoped to its own prefix (an S3 prefix or a
registry repository), instead of one key shared by every server. A compromised host then cannot
read or replace another server's releases. When restoring, the agent checks the images against
the digests recorded at deploy time and rejects a replaced archive or a re-pushed tag
(`STORAGE_FAILED`, `reason: digest`). Environment names in storage paths and tags are normalised
to lowercase letters, digits and hyphens: `My Env` → `my-env`.

## Deploying from CI

```sh
export MICRORUN_URL=https://microrun.example.com
export MICRORUN_DEPLOY_TOKEN=<the environment's deploy token, from your CI secrets>
npx microrun deploy \
  --image web=registry.example.com/shop/web:$GIT_SHA \
  --image worker=registry.example.com/shop/worker:$GIT_SHA \
  --commit "$GIT_SHA" --branch prod
```

`--image <ref>` without a service name applies one image to every service of the environment.
Exit codes: `0` — success, or the commit is already active; `2` — rejected (`COMMIT_BLOCKED`,
`COMMIT_EXPIRED`, `SCHEMA_DESTRUCTIVE`, `BRANCH_MISMATCH`, `DB_MARKER_MISMATCH`, …) with the
reason in the message; `1` — the deploy failed; `3` — a usage or network error, or the
environment stayed busy longer than `--busy-timeout`.

## Migrations: expand / contract / cleanup

microrun does not write migrations. It runs your commands from the release image in a one-off
container of the `migration_service` service, with that service's env plus `MICRORUN_ENV`,
`MICRORUN_RELEASE_COMMIT`, `MICRORUN_DEPLOYED_AT` and `MICRORUN_ROLLED_BACK_AT` (ISO 8601 UTC).

- **`expand_cmd`** only adds: new tables, nullable columns, columns with a default, indexes.
  The schema after expand must work with both the old and the new code. Before a production
  deploy, microrun runs expand against a temporary copy of the schema and rejects destructive
  changes (`SCHEMA_DESTRUCTIVE`) before the real database is touched.
- **`contract_cmd`** removes what is no longer used. microrun runs it only once every older
  release has left the rollback window.
- **`cleanup_cmd`** holds optional rules that remove data a release created, after it was rolled
  back. Its stdout protocol is JSON lines; any other line goes to the log:
  - `--dry-run` → `{"rule":"<id>","description":"<text>","count":<n>}`
  - `--apply --rules=<id>,<id>` → `{"rule":"<id>","deleted":<n>}`

The admin sees the record count for each rule and confirms the cleanup in the UI.

## Good to know

- microrun writes `docker-compose.microrun.yml` next to your compose files. A manual
  `docker compose up` without it brings back the image from your compose file, not the active
  release.
- Access to `docker.sock` is equivalent to root on the host, for the built-in and the remote
  agent alike.
- A rolling replacement needs a healthcheck and no `container_name` or published ports on the
  service (traffic goes through your proxy or the bundled Caddy).
- The bundled proxy `microrun-proxy` joins one network per compose project
  (`microrun-proxy-<project>`), so services of different projects cannot reach each other
  through it.
- SQLite as the application database with rolling replacement: two containers write one file
  during the switch, so turn on WAL in the application.
- Old columns live until the end of the rollback window; that is the price of rollback without
  DDL.

## Development

```sh
pnpm install
pnpm -r build
pnpm test          # unit and integration tests
pnpm test:docker   # agent tests against a real Docker engine
pnpm test:e2e      # Playwright, the full scenario
```

The stylesheet `packages/server/src/public/app.css` is generated from `app.src.css` by `pnpm -r build` and is gitignored; run `pnpm --filter @microrun/server dev:css` in a second terminal to rebuild it on change.
