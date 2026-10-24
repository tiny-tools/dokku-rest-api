# dokku-rest-api

A lightweight Dokku plugin that runs a small HTTP daemon on the Dokku host and exposes

- a **REST/JSON API** for the everyday things: app status, scaling, deploys, restarts, environment variables, logs
- a **1:1 CLI bridge** (`POST /api/v1/cli`) that passes allow-listed Dokku commands and their arguments straight to the `dokku` binary, without a shell
- a **GitHub Action** (`tiny-tools/dokku-rest-api@v1`) so CI pipelines can deploy with an API token instead of an SSH key

API tokens can be limited per app (exact name, wildcard like `staging-*` or `*`), can cover several apps and carry fine-grained scopes (read-only vs. read/write). Tokens, permissions, the allow-list and an audit log live in a SQLite database at `/var/lib/dokku/data/api/storage.db`.

Runtime requirements: a recent Dokku release (the API reads `--format json` output from `apps:list`, `ps:scale` and the `*:report` commands) and **Node.js ≥ 22.13** on the host. There are no npm runtime dependencies; SQLite comes from Node's built-in `node:sqlite`.

```
client ──HTTPS──▶ nginx (api:setup) ──▶ 127.0.0.1:5099 dokku-api daemon ──execve──▶ /usr/bin/dokku
                                         1. bearer token (SHA-256 hash lookup)
                                         2. app pattern + scope check
                                         3. allow-list / argument validation
```

## Installation

```sh
# Node.js 22.13+ must be installed on the host first, e.g. via NodeSource
sudo dokku plugin:install https://github.com/tiny-tools/dokku-rest-api.git --name api
```

`--name api` matters: it makes the commands available as `dokku api:*`. The install hook creates the data directory, writes `/etc/default/dokku-api`, migrates the database and starts the `dokku-api.service` systemd unit (running as the `dokku` user, listening on `127.0.0.1:5099`).

Expose it on a domain through Dokku's nginx:

```sh
dokku api:setup --domain api.dokku.example.com

# TLS with Let's Encrypt (certbot webroot; the challenge directory is already served)
sudo certbot certonly --webroot -w /var/lib/dokku/data/api/acme -d api.dokku.example.com \
  --deploy-hook 'systemctl reload nginx'
dokku api:setup --domain api.dokku.example.com \
  --ssl-cert /etc/letsencrypt/live/api.dokku.example.com/fullchain.pem \
  --ssl-key /etc/letsencrypt/live/api.dokku.example.com/privkey.pem
```

To update the plugin later: `sudo dokku plugin:update api && sudo dokku plugin:install` (the second command re-runs the install hook, which restarts the daemon).

## Tokens and permissions

```sh
# CI token: full read/write on one app, expires in 90 days
dokku api:token-create github-prod --app shop-api --scope readwrite --expires-in 90d

# Dashboard token: read-only on every staging app
dokku api:token-create dashboard --app 'staging-*' --scope readonly

# One token, different rights per app
dokku api:token-create mixed --app app1 --scope read --app app2 --scope read,deploy,config:write

dokku api:perm-add dashboard --app shop-api --scope read
dokku api:perm-remove dashboard --app shop-api --scope read
dokku api:perm-list
dokku api:token-list
dokku api:token-revoke github-prod
dokku api:audit --limit 20
```

The token is printed exactly once; only its SHA-256 hash is stored (tokens are 256-bit random values, so a slow password hash buys nothing here).

| Scope          | Allows                                                                 |
|----------------|------------------------------------------------------------------------|
| `read`         | `GET /apps`, app report, status, formation; `*:report` via the bridge  |
| `logs`         | `GET /apps/{app}/logs`, `logs` / `logs:failed` via the bridge          |
| `config:read`  | read environment variables                                             |
| `config:write` | set environment variables                                              |
| `scale`        | change the process formation                                           |
| `restart`      | restart / start / stop                                                 |
| `deploy`       | deploy an image, sync a git repo, rebuild                              |
| `cli`          | custom commands you add to the allow-list yourself                     |

Aliases: `readonly` = `read,logs` · `readwrite` = everything except `cli` · `all` / `*` = every scope.

There is deliberately nothing that destroys apps or unsets variables yet.

## REST API

All endpoints live under `/api/v1`, take and return JSON, and need `Authorization: Bearer dk_live_…` (except `/health`). Errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`. 401 means the token is missing, invalid, revoked or expired. 403 means it lacks the scope for that app. A Dokku command that exits non-zero returns 422, with `exit_code`, `stdout` and `stderr` in the body.

| Method & path                         | Scope          | Dokku command                         | Body / query |
|---------------------------------------|----------------|---------------------------------------|--------------|
| `GET /health`                         | –              | –                                     | |
| `GET /me`                             | any            | –                                     | token name and permissions |
| `GET /allowlist`                      | any            | –                                     | bridge commands this token may use |
| `GET /apps`                           | `read`         | `apps:list`                           | only apps the token can see |
| `GET /apps/{app}`                     | `read`         | `apps:report`                         | |
| `GET /apps/{app}/status`              | `read`         | `ps:report`, `ps:scale`               | `deployed`, `running`, `processes`, `formation` |
| `GET /apps/{app}/formation`           | `read`         | `ps:scale`                            | |
| `PATCH /apps/{app}/formation`         | `scale`        | `ps:scale app web=2 …`                | `{"web": 2, "worker": 1}`, `?skip_deploy=true` |
| `GET /apps/{app}/config`              | `config:read`  | `config:export --format json`         | |
| `GET /apps/{app}/config/{KEY}`        | `config:read`  | `config:get`                          | 404 if unset |
| `PATCH /apps/{app}/config`            | `config:write` | `config:set --encoded`                | `{"KEY": "value"}`, `?restart=false` |
| `PUT /apps/{app}/config/{KEY}`        | `config:write` | `config:set --encoded`                | `{"value": "…"}`, `?restart=false` |
| `GET /apps/{app}/logs`                | `logs`         | `logs --num N [--ps P]`               | `?lines=100&process=web` |
| `POST /apps/{app}/restart`            | `restart`      | `ps:restart`                          | optional `{"process": "web"}` |
| `POST /apps/{app}/start` / `stop`     | `restart`      | `ps:start` / `ps:stop`                | |
| `POST /apps/{app}/deploys`            | `deploy`       | `git:from-image` / `git:sync --build` / `ps:rebuild` | `{"image": "ghcr.io/org/app:sha"}` or `{"repository": "https://…", "ref": "main"}` or `{}` |
| `POST /cli`                           | per entry      | any allow-listed command              | see below |
| `POST /apps/{app}/cli/{ns}/{sub}`     | per entry      | `dokku ns:sub …`                      | `{"args": [...]}` |

```sh
curl -s https://api.dokku.example.com/api/v1/apps/shop-api/status -H "Authorization: Bearer $TOKEN"
curl -s -X PATCH https://api.dokku.example.com/api/v1/apps/shop-api/formation \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"web": 2}'
curl -s -X PATCH 'https://api.dokku.example.com/api/v1/apps/shop-api/config?restart=false' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"FEATURE_X": "on"}'
```

Config values are base64-encoded before they are handed to `config:set --encoded`, so spaces, quotes and newlines are safe. Echoed commands are redacted so CI logs don't show the values.

## 1:1 CLI bridge

```http
POST /api/v1/cli
Authorization: Bearer dk_live_…
Content-Type: application/json

{"command": "config:set", "app": "shop-backend", "args": ["--no-restart", "FEATURE_NEW_CHECKOUT=true", "MAX_WORKERS=8"]}
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

The argv passed to `dokku` is `[command, ...flags, app, ...args]`. Dokku's Go subcommands stop parsing flags at the first positional argument, so leading `-…` entries in `args` are moved in front of the app automatically. If a flag takes a separate value, either use `--flag=value` or pass an explicit `"flags": [...]` array. The same call works path-based: `POST /api/v1/apps/shop-backend/cli/config/set` with `{"args": [...]}`.

A request is allowed when an allow-list entry (global, or bound to this token) matches the command, the token holds that entry's scope on the app, and **every single argument** matches the entry's regex. `--app`, `--global`, `--all` and `--trace` are always rejected, because Dokku's top-level parser would honour them anywhere in argv (`--app` could retarget the command to another app). Commands run via `execve` with no shell.

Default allow-list (seeded on first start, see `dokku api:allowlist-list`):

| Scope          | Commands |
|----------------|----------|
| `read`         | `apps:report`, `apps:exists`, `ps:report`, `domains:report`, `git:report`, `ports:report`, `proxy:report`, `checks:report`, `resource:report`, `nginx:report` |
| `logs`         | `logs` (no `--tail`), `logs:failed` |
| `config:read`  | `config:show`, `config:get`, `config:keys`, `config:export` |
| `config:write` | `config:set` (no `--global`) |
| `scale`        | `ps:scale` |
| `restart`      | `ps:restart`, `ps:start`, `ps:stop` |
| `deploy`       | `ps:rebuild`, `git:from-image`, `git:sync` (https/git@ remotes only) |

Add your own commands (they need the `cli` scope unless you say otherwise):

```sh
dokku api:allowlist-add postgres:info --flags '^--[a-z-]+$' --description 'service info'
dokku api:allowlist-add 'letsencrypt:*' --scope deploy --token github-prod
dokku api:allowlist-add apps:list --no-app          # not app-bound: needs the scope on "*"
dokku api:allowlist-remove 12
```

With `require_app_match` (the default), `app` is mandatory and has to match one of the token's app patterns for the entry's scope. For service plugins such as `postgres:*`, the "app" is the first positional argument (the service name).

## GitHub Action

```yaml
- name: Deploy to Dokku
  uses: tiny-tools/dokku-rest-api@v1
  with:
    dokku_url: https://api.dokku.example.com
    api_token: ${{ secrets.DOKKU_API_TOKEN }}
    app_name: shop-api
    config: |
      RELEASE_SHA=${{ github.sha }}
    deploy_image: ghcr.io/my-org/shop-api:${{ github.sha }}
    scale: web=2 worker=1
    cli_commands: |
      ["ps:report"]
```

| Input               | Description |
|---------------------|-------------|
| `dokku_url`         | API base URL (required) |
| `api_token`         | token, store it as a secret (required, masked in logs) |
| `app_name`          | target app |
| `config`            | `KEY=value` lines to set; when a deploy follows, the app isn't restarted twice |
| `config_restart`    | restart after setting config (default `true`) |
| `deploy_image`      | deploy a Docker image (`git:from-image`) |
| `deploy_repository` / `deploy_ref` | sync and build a git repository (`git:sync --build`) |
| `rebuild`           | `ps:rebuild` the current source |
| `scale`             | formation like `web=2 worker=1` |
| `restart`           | restart the app |
| `cli_commands`      | one JSON array per line (`["ps:scale", "web=2"]`; the app is added for you) or a full request object |
| `timeout_seconds`   | HTTP timeout per request (default 900) |

Steps run in the order config → deploy → scale → restart → cli_commands. If none of these inputs is set, the action prints the app status (output `status`). The `results` output holds every step's result as JSON. `stdout` holds the output of the last `cli_commands` entry.

## Webhook

```sh
dokku api:set webhook-url https://hooks.example.com/dokku
dokku api:set webhook-secret s3cr3t     # optional, adds X-Dokku-Api-Signature: sha256=<hmac>
```

After every deploy the `post-deploy` trigger POSTs `{"event": "post-deploy", "app": …, "image_tag": …, "timestamp": …}`. Webhook failures never fail a deploy.

## Configuration

`/etc/default/dokku-api` (read by the systemd unit and the CLI):

| Variable                     | Default                               |
|------------------------------|---------------------------------------|
| `DOKKU_API_HOST`             | `127.0.0.1`                           |
| `DOKKU_API_PORT`             | `5099` (re-run `api:setup` after changing it) |
| `DOKKU_API_DB`               | `/var/lib/dokku/data/api/storage.db`  |
| `DOKKU_API_NODE`             | node binary found at install time     |
| `DOKKU_API_EXEC_TIMEOUT_MS`  | `900000`                              |

After changing the file, run `sudo systemctl restart dokku-api`.

## Development

```sh
npm install
npm test          # builds dist/ and runs the test suite against a fake dokku binary
```

`dist/` is committed on purpose: the Dokku plugin and the GitHub Action run straight from a git checkout, without a build step. Run `npm run build` before committing changes under `src/`.

Layout: `src/server.ts` (REST routes), `src/allowlist.ts` (bridge authorisation and default allow-list), `src/db.ts` (SQLite schema and queries), `src/admin.ts` (`dokku api:*`), `src/action/` (GitHub Action), and the plugin hooks `install`, `uninstall`, `post-deploy`, `commands` and `subcommands/`.
