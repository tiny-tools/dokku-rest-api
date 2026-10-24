# dokku-rest-api

**Control your Dokku apps over HTTPS with scoped API tokens instead of SSH keys.**

`dokku-rest-api` is a Dokku plugin. It runs a small HTTP daemon on your Dokku host and gives you:

- **A REST/JSON API** for day-to-day operations: app status, scaling, deploys, restarts, environment variables and logs.
- **A 1:1 CLI bridge** that passes allow-listed Dokku commands with their arguments straight to the `dokku` binary, without a shell in between.
- **A GitHub Action** that deploys from CI with nothing more than a URL and a token.

Each token can be limited to specific apps (`shop-api`, `staging-*` or `*`) and to specific actions (read-only, deploy, config…). A single token can cover several apps with different rights on each.

```
GitHub Actions / curl / dashboards
        │  HTTPS + Bearer token
        ▼
nginx (set up by `dokku api:setup`)
        │
        ▼
dokku-api daemon on 127.0.0.1:5099  ──execve──▶  /usr/bin/dokku
   1. token check (hashed, revocable, expiring)
   2. app pattern + scope check
   3. allow-list + per-argument validation
        │
        ▼
SQLite: /var/lib/dokku/data/api/storage.db
```

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Managing tokens](#managing-tokens)
- [REST API](#rest-api)
- [CLI bridge](#cli-bridge)
- [GitHub Action](#github-action)
- [Webhook](#webhook)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Development](#development)

## Features

- Tokens scoped per app, with wildcards, and per action (`read`, `logs`, `config:read`, `config:write`, `scale`, `restart`, `deploy`, `cli`)
- Optional token expiry, instant revocation and an audit log of every request
- REST endpoints for status, formation, deploys (image, git or rebuild), restart/start/stop, config and logs
- A generic CLI bridge, so new Dokku commands work without new endpoints once you allow-list them
- A dependency-free GitHub Action for deploying, scaling, setting config and running commands
- An optional webhook after every deploy, with an HMAC signature
- No npm runtime dependencies (SQLite comes from Node's built-in `node:sqlite`)

Deliberately left out for now: destroying apps and unsetting environment variables.

## Requirements

- A recent Dokku release. The API reads `--format json` output from `apps:list`, `ps:scale` and the `*:report` commands.
- **Node.js 22.13 or newer** on the Dokku host, for example from [NodeSource](https://github.com/nodesource/distributions)
- systemd (for the bundled service unit) and nginx (Dokku's default proxy)

## Quick start

```sh
# 1. On the Dokku host: install the plugin (as root)
sudo dokku plugin:install https://github.com/tiny-tools/dokku-rest-api.git --name api

# 2. Expose the API on a domain
dokku api:setup --domain api.dokku.example.com

# 3. Create a token for CI with read/write access to one app
dokku api:token-create github-prod --app shop-api --scope readwrite --expires-in 90d
#    → prints dk_live_… exactly once

# 4. Try it
curl -s https://api.dokku.example.com/api/v1/apps/shop-api/status \
  -H "Authorization: Bearer dk_live_…"
```

Then store the token as the `DOKKU_API_TOKEN` secret in GitHub and use the [GitHub Action](#github-action).

## Installation

```sh
sudo dokku plugin:install https://github.com/tiny-tools/dokku-rest-api.git --name api
```

`--name api` is required. Without it Dokku names the plugin `rest-api`, and the commands would not be available as `dokku api:*`.

The install hook:

1. checks for Node.js 22.13 or newer
2. creates `/var/lib/dokku/data/api/` (owned by `dokku`)
3. writes `/etc/default/dokku-api` (only if it doesn't exist yet)
4. creates or migrates the SQLite database and seeds the default allow-list
5. adds `/etc/nginx/conf.d/dokku-api.conf`, which includes the config written by `api:setup`
6. installs, enables and (re)starts `dokku-api.service`, which runs as the `dokku` user on `127.0.0.1:5099`

### Exposing the API with TLS

```sh
dokku api:setup --domain api.dokku.example.com
```

Without TLS, tokens travel in plain text. For Let's Encrypt, the challenge directory is already served, so `certbot`'s webroot mode works:

```sh
sudo certbot certonly --webroot -w /var/lib/dokku/data/api/acme \
  -d api.dokku.example.com --deploy-hook 'systemctl reload nginx'

dokku api:setup --domain api.dokku.example.com \
  --ssl-cert /etc/letsencrypt/live/api.dokku.example.com/fullchain.pem \
  --ssl-key  /etc/letsencrypt/live/api.dokku.example.com/privkey.pem
```

`api:setup` validates the generated config with `nginx -t` and restores the previous version if nginx rejects it.

## Managing tokens

All management happens on the host through `dokku api:*`. Run `dokku api:help` for the full list.

```sh
# Read-only dashboard token for all staging apps
dokku api:token-create dashboard --app 'staging-*' --scope readonly

# Different rights per app in one token
dokku api:token-create mixed --app app1 --scope read --app app2 --scope read,deploy,config:write

# Change permissions later
dokku api:perm-add dashboard --app shop-api --scope read
dokku api:perm-remove dashboard --app shop-api --scope read
dokku api:perm-list [<token>]

dokku api:token-list
dokku api:token-revoke github-prod      # takes effect immediately
dokku api:audit --limit 20              # recent requests
dokku api:report                        # daemon health, database, settings
```

### Scopes

| Scope          | Allows                                                                   |
|----------------|--------------------------------------------------------------------------|
| `read`         | list apps, app report, status, formation; `*:report` through the bridge  |
| `logs`         | recent logs (`logs`, `logs:failed`)                                      |
| `config:read`  | read environment variables                                               |
| `config:write` | set environment variables                                                |
| `scale`        | change the process formation                                             |
| `restart`      | restart, start and stop                                                  |
| `deploy`       | deploy an image, sync a git repository, rebuild                          |
| `cli`          | commands you add to the allow-list yourself                              |

| Alias       | Expands to                                  |
|-------------|---------------------------------------------|
| `readonly`  | `read`, `logs`                              |
| `readwrite` | every scope except `cli`                    |
| `all`, `*`  | every scope                                 |

App patterns are exact names, globs with `*` (`staging-*`), or `*` for all apps. Commands that aren't tied to an app require the scope on `*`.

## REST API

- Base path: `/api/v1`
- Authentication: `Authorization: Bearer dk_live_…` on every endpoint except `/health`
- Request and response bodies are JSON (`Content-Type: application/json`)
- Errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`

| Status | Meaning |
|--------|---------|
| `400`  | invalid input (app name, body, query) |
| `401`  | token missing, invalid, revoked or expired |
| `403`  | token lacks the scope for this app, or the command or argument isn't allowed |
| `404`  | unknown route, app or config key |
| `422`  | the Dokku command ran but exited non-zero; the body has `exit_code`, `stdout` and `stderr` |
| `504`  | the Dokku command hit the execution timeout |

### Endpoints

| Method & path                     | Scope          | Runs                                   | Input |
|-----------------------------------|----------------|----------------------------------------|-------|
| `GET /health`                     | –              | –                                      | |
| `GET /me`                         | any            | –                                      | |
| `GET /allowlist`                  | any            | –                                      | |
| `GET /apps`                       | `read`         | `apps:list`                            | only apps the token may see |
| `GET /apps/{app}`                 | `read`         | `apps:report`                          | |
| `GET /apps/{app}/status`          | `read`         | `ps:report`, `ps:scale`                | |
| `GET /apps/{app}/formation`       | `read`         | `ps:scale`                             | |
| `PATCH /apps/{app}/formation`     | `scale`        | `ps:scale`                             | `{"web": 2, "worker": 1}`, `?skip_deploy=true` |
| `GET /apps/{app}/config`          | `config:read`  | `config:export`                        | |
| `GET /apps/{app}/config/{KEY}`    | `config:read`  | `config:get`                           | |
| `PATCH /apps/{app}/config`        | `config:write` | `config:set --encoded`                 | `{"KEY": "value"}`, `?restart=false` |
| `PUT /apps/{app}/config/{KEY}`    | `config:write` | `config:set --encoded`                 | `{"value": "…"}`, `?restart=false` |
| `GET /apps/{app}/logs`            | `logs`         | `logs`                                 | `?lines=100&process=web` |
| `POST /apps/{app}/restart`        | `restart`      | `ps:restart`                           | optional `{"process": "web"}` |
| `POST /apps/{app}/start`          | `restart`      | `ps:start`                             | |
| `POST /apps/{app}/stop`           | `restart`      | `ps:stop`                              | |
| `POST /apps/{app}/deploys`        | `deploy`       | see below                              | |
| `POST /cli`                       | per entry      | any allow-listed command               | [CLI bridge](#cli-bridge) |
| `POST /apps/{app}/cli/{ns}/{sub}` | per entry      | `dokku ns:sub …`                       | `{"args": [...]}` |

`POST /apps/{app}/deploys` picks the deploy method from the body:

| Body                                                  | Runs |
|-------------------------------------------------------|------|
| `{"image": "ghcr.io/org/app:sha"}` (+ `"force": true`) | `git:from-image` |
| `{"repository": "https://github.com/org/app.git", "ref": "main"}` | `git:sync --build` |
| `{}` or no body                                       | `ps:rebuild` |

### Examples

```sh
API=https://api.dokku.example.com/api/v1
AUTH="Authorization: Bearer $DOKKU_API_TOKEN"

# Status
curl -s "$API/apps/shop-api/status" -H "$AUTH"
```

```json
{
  "name": "shop-api",
  "deployed": true,
  "running": true,
  "processes": 3,
  "formation": { "web": 2, "worker": 1 },
  "report": { "…": "raw ps:report output" }
}
```

```sh
# Scale
curl -s -X PATCH "$API/apps/shop-api/formation" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"web": 3}'

# Set env vars without restarting
curl -s -X PATCH "$API/apps/shop-api/config?restart=false" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"FEATURE_X": "on", "MAX_WORKERS": 8}'

# Deploy an image
curl -s -X POST "$API/apps/shop-api/deploys" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"image": "ghcr.io/my-org/shop-api:1.4.2"}'

# Last 200 log lines of the web process
curl -s "$API/apps/shop-api/logs?lines=200&process=web" -H "$AUTH"
```

Config values are base64-encoded and passed with `config:set --encoded`, so spaces, quotes and newlines are safe. The echoed command is redacted, so values never show up in CI logs.

Deploys run synchronously. A request can take several minutes, so set your client's timeout to match (the GitHub Action defaults to 900 seconds).

## CLI bridge

When no dedicated endpoint exists, the bridge passes commands through 1:1:

```http
POST /api/v1/cli
Authorization: Bearer dk_live_…
Content-Type: application/json

{
  "command": "config:set",
  "app": "shop-backend",
  "args": ["--no-restart", "FEATURE_NEW_CHECKOUT=true", "MAX_WORKERS=8"]
}
```

```json
{
  "ok": true,
  "exit_code": 0,
  "command_executed": "dokku config:set --no-restart shop-backend FEATURE_NEW_CHECKOUT=true MAX_WORKERS=8",
  "stdout": "-----> Setting config vars\n…",
  "stderr": "",
  "duration_ms": 342,
  "timed_out": false
}
```

The same call works path-based: `POST /api/v1/apps/shop-backend/cli/config/set` with `{"args": [...]}`. For a command without a subcommand, use `…/cli/logs`.

**Argument order.** The daemon runs `dokku <command> <flags…> <app> <args…>`, because Dokku's subcommands stop reading flags at the first positional argument. Leading `-…` entries in `args` are moved in front of the app automatically. For a flag that takes a separate value, use `--flag=value` or send an explicit `"flags": [...]` array.

**Authorisation.** A request is allowed only if:

1. an allow-list entry (global, or bound to this token) matches the command (`ps:scale`, or globs like `postgres:*`),
2. the token holds that entry's scope on the target app, and
3. **every single argument** matches the entry's regex.

`--app`, `--global`, `--all` and `--trace` are always rejected. Dokku honours them anywhere in argv, and `--app` could retarget the command to an app outside the token's scope.

### Default allow-list

The default allow-list is seeded when the database is created. Run `dokku api:allowlist-list` to see it with its regexes.

| Scope          | Commands |
|----------------|----------|
| `read`         | `apps:report`, `apps:exists`, `ps:report`, `domains:report`, `git:report`, `ports:report`, `proxy:report`, `checks:report`, `resource:report`, `nginx:report` |
| `logs`         | `logs` (without `--tail`), `logs:failed` |
| `config:read`  | `config:show`, `config:get`, `config:keys`, `config:export` |
| `config:write` | `config:set` |
| `scale`        | `ps:scale` |
| `restart`      | `ps:restart`, `ps:start`, `ps:stop` |
| `deploy`       | `ps:rebuild`, `git:from-image`, `git:sync` (only `https://` and `git@` remotes) |

### Adding commands

```sh
# Needs the `cli` scope by default
dokku api:allowlist-add postgres:info --flags '^--[a-z-]+$' --description 'service info'

# Tie an entry to an existing scope and to one token only
dokku api:allowlist-add 'letsencrypt:*' --scope deploy --token github-prod

# Commands that don't take an app (the token needs the scope on "*")
dokku api:allowlist-add apps:list --no-app

dokku api:allowlist-remove 12
```

For service plugins (`postgres:*`, `redis:*`, …), `app` is the first positional argument, i.e. the service name, and it is matched against the token's app patterns.

`GET /api/v1/allowlist` shows a client which bridge commands its token may use.

## GitHub Action

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/my-org/shop-api:${{ github.sha }}

      - uses: tiny-tools/dokku-rest-api@v1
        with:
          dokku_url: https://api.dokku.example.com
          api_token: ${{ secrets.DOKKU_API_TOKEN }}
          app_name: shop-api
          config: |
            RELEASE_SHA=${{ github.sha }}
          deploy_image: ghcr.io/my-org/shop-api:${{ github.sha }}
          scale: web=2 worker=1
```

### Inputs

| Input               | Default | Description |
|---------------------|---------|-------------|
| `dokku_url`         |         | API base URL (required) |
| `api_token`         |         | API token (required, masked in logs) |
| `app_name`          |         | target app |
| `config`            |         | `KEY=value` per line; `#` comments allowed |
| `config_restart`    | `true`  | restart after setting config; skipped automatically when a deploy follows |
| `deploy_image`      |         | Docker image to deploy (`git:from-image`) |
| `deploy_repository` |         | git repository to sync and build (`git:sync --build`) |
| `deploy_ref`        |         | branch, tag or commit for `deploy_repository` |
| `rebuild`           | `false` | rebuild the current source (`ps:rebuild`) |
| `scale`             |         | formation, e.g. `web=2 worker=1` |
| `restart`           | `false` | restart the app |
| `cli_commands`      |         | one JSON array per line, e.g. `["ps:scale", "web=2"]` (the app is added for you), or a full `/cli` request object |
| `timeout_seconds`   | `900`   | HTTP timeout per request |

Steps run in this order: config → deploy → scale → restart → cli_commands. If none of these inputs is set, the action just reports the app status.

### Outputs

| Output    | Description |
|-----------|-------------|
| `results` | JSON array with the result of every step |
| `status`  | app status JSON (only in status mode) |
| `stdout`  | stdout of the last `cli_commands` entry |

## Webhook

```sh
dokku api:set webhook-url https://hooks.example.com/dokku
dokku api:set webhook-secret s3cr3t     # optional
dokku api:set webhook-url               # clears the setting
```

After every deploy, the `post-deploy` trigger sends:

```json
{ "event": "post-deploy", "app": "shop-api", "image_tag": "latest", "timestamp": "2026-10-24T12:00:00.000Z" }
```

With a secret set, the request carries `X-Dokku-Api-Signature: sha256=<hex HMAC of the body>`. Webhook failures are logged and never fail a deploy.

## Configuration

The systemd unit and `dokku api:*` read `/etc/default/dokku-api`:

| Variable                    | Default                              | Notes |
|-----------------------------|--------------------------------------|-------|
| `DOKKU_API_HOST`            | `127.0.0.1`                          | keep it on loopback and use nginx |
| `DOKKU_API_PORT`            | `5099`                               | re-run `api:setup` after changing it |
| `DOKKU_API_DB`              | `/var/lib/dokku/data/api/storage.db` | |
| `DOKKU_API_NODE`            | node found at install time           | |
| `DOKKU_API_EXEC_TIMEOUT_MS` | `900000`                             | maximum runtime of one Dokku command |

After editing the file, apply the change with `sudo systemctl restart dokku-api`.

## Security model

- **Tokens** are 256-bit random values (`dk_live_…`). Only their SHA-256 hash is stored, and they are shown exactly once.
- **Least privilege:** every request needs a concrete scope on the concrete app. The app list is filtered to what the token may see.
- **No shell:** commands run via `execve` with an argv array, so shell injection is impossible by construction.
- **Validation:** bridge arguments are checked one by one against the allow-list regex. Dokku's global flags (`--app`, `--global`, `--all`, `--trace`) are hard-blocked, and Dokku-specific environment variables are stripped from the child process.
- **Network:** the daemon listens on loopback only. nginx overwrites `X-Forwarded-For`, so the client IPs in the audit log can't be spoofed.
- **Audit:** every authenticated request is logged with token, path, command, app, status and exit code, but never with config values. Revoking a token keeps its history.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `dokku api:report` says "not reachable" | `sudo systemctl status dokku-api` and `sudo journalctl -u dokku-api -n 50` |
| `dokku api` is "not a dokku command" | the plugin was installed without `--name api`; reinstall with it |
| Install fails with "Node.js >= 22.13 is required" | install a current Node.js and re-run `sudo dokku plugin:install` |
| `502 Bad Gateway` from nginx | the daemon isn't running, or `DOKKU_API_PORT` differs from the port in the nginx config (re-run `api:setup`) |
| `401` | `dokku api:token-list` shows whether the token is revoked or expired |
| `403 Missing scope` | `dokku api:perm-list <token>` |
| `403 Argument not permitted` | compare the argument with the regex in `dokku api:allowlist-list` |
| Deploys time out in the client | raise the client timeout; the server allows up to `DOKKU_API_EXEC_TIMEOUT_MS` |

## Updating and uninstalling

```sh
# Update, then re-run the install hook (migrates the database and restarts the daemon)
sudo dokku plugin:update api
sudo dokku plugin:install

# Uninstall: removes the service and nginx config, keeps the database
sudo dokku plugin:uninstall api
sudo rm -rf /var/lib/dokku/data/api /etc/default/dokku-api   # optional: remove all data
```

## Development

```sh
npm install
npm test           # builds dist/ and runs all tests against a fake dokku binary
npm run typecheck
shellcheck -x -e SC1091 install uninstall commands post-deploy bin/dokku-api subcommands/*
```

Run the daemon locally against the fake binary:

```sh
npm run build
DOKKU_API_DB=./dev.db DOKKU_API_DOKKU_BIN=$PWD/test/fake-dokku.mjs bin/dokku-api cli token-create dev --app '*' --scope all
DOKKU_API_DB=./dev.db DOKKU_API_DOKKU_BIN=$PWD/test/fake-dokku.mjs bin/dokku-api daemon
```

`dist/` is committed on purpose: both the Dokku plugin and the GitHub Action run straight from a git checkout, without a build step. CI fails if `dist/` is out of date.

```
├── action.yml            GitHub Action definition (runs dist/action/main.js)
├── plugin.toml           Dokku plugin metadata
├── install, uninstall    Dokku triggers (systemd unit, nginx include, data dir)
├── post-deploy           Dokku trigger → webhook
├── commands              `dokku help` / `dokku api:help`
├── subcommands/          `dokku api:*` (thin wrappers; setup is bash)
├── bin/dokku-api         launcher for dist/{daemon,cli,webhook}.js
├── src/
│   ├── server.ts         HTTP server and REST routes
│   ├── allowlist.ts      CLI bridge authorisation and default allow-list
│   ├── db.ts             SQLite schema, migrations, queries
│   ├── scopes.ts         scopes, aliases, glob matching
│   ├── dokku.ts          execve wrapper around the dokku binary
│   ├── admin.ts          `dokku api:*` implementation
│   ├── webhook.ts        post-deploy webhook
│   └── action/           GitHub Action
├── dist/                 compiled output (committed)
└── test/                 node:test suites and the fake dokku binary
```
