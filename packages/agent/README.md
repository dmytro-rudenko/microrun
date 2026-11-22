# microrun

The agent and the deploy CLI of [microrun](https://github.com/dmytro-rudenko/microrun), a
self-hosted, safe release rollback for Docker Compose projects without Kubernetes.

Requires Node.js 26 or newer. The agent also needs Docker with Compose 2.30 or newer.

```sh
npm i -g microrun
```

## `microrun agent`

Connects a host to the microrun server so the server can deploy and roll back the Compose
projects on it. The agent dials out over a WebSocket; the host needs no inbound ports and no
SSH keys.

```sh
MICRORUN_AGENT_TOKEN=<token from Settings → Servers> microrun agent --url https://microrun.example.com
```

| Option | Environment | Default |
|---|---|---|
| `--url` | `MICRORUN_URL` | — |
| `--token` | `MICRORUN_AGENT_TOKEN` | — |
| `--state-dir` | — | `~/.microrun` |

Prefer the environment variable for the token, so it stays out of the process list.

Run it as a systemd service:

```sh
sudo install -d -m 700 /etc/microrun
sudo install -m 600 /dev/null /etc/microrun/agent.env
echo 'MICRORUN_AGENT_TOKEN=<token>' | sudo tee /etc/microrun/agent.env >/dev/null
microrun agent install-service --url https://microrun.example.com | sudo tee /etc/systemd/system/microrun-agent.service
sudo systemctl enable --now microrun-agent
```

The generated unit reads the token from `EnvironmentFile=/etc/microrun/agent.env` and never
contains it.

## `microrun deploy`

Deploys a release from CI and follows it until it finishes.

```sh
export MICRORUN_URL=https://microrun.example.com
export MICRORUN_DEPLOY_TOKEN=<the environment's deploy token>
microrun deploy \
  --image web=registry.example.com/shop/web:$GIT_SHA \
  --image worker=registry.example.com/shop/worker:$GIT_SHA \
  --commit "$GIT_SHA" --branch prod
```

| Option | Meaning |
|---|---|
| `--url`, `MICRORUN_URL` | server URL |
| `--token`, `MICRORUN_DEPLOY_TOKEN` | deploy token of the environment |
| `--image <svc>=<ref>` | image per service, repeatable; a bare `<ref>` applies to every service |
| `--commit`, `--branch` | the commit and branch being deployed |
| `--author`, `--message` | default to `git log -1` |
| `--busy-timeout <s>` | how long to wait for a busy environment, default 600 |
| `--lang <tag>` | message language; defaults to `LC_ALL`/`LANG` |

Exit codes: `0` success or already active; `2` rejected (`COMMIT_BLOCKED`, `COMMIT_EXPIRED`,
`SCHEMA_DESTRUCTIVE`, `BRANCH_MISMATCH`, `DB_MARKER_MISMATCH`, …); `1` the deploy failed;
`3` usage or network error, or the environment stayed busy past `--busy-timeout`.

## License

MIT
