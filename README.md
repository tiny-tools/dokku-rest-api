# dokku-rest-api

**Deploy to Dokku from GitHub Actions without SSH keys and without secrets.**

`dokku-rest-api` is a Dokku plugin. It runs a small HTTP daemon on your Dokku host and gives you:

- **Secret-free deploys from GitHub Actions.** You tell the server once which repository may do what (`dokku api:trust-github`). The workflow proves who it is with an ID token from GitHub (OIDC). No repository needs an SSH key or a token stored in its secrets.
- **A REST/JSON API** for day-to-day operations: app status, scaling, deploys, restarts, environment variables and logs.
- **A 1:1 CLI bridge** that passes allow-listed Dokku commands with their arguments straight to the `dokku` binary, without a shell in between.
- **A GitHub Action** that uses all of this with nothing more than a URL.

Every caller can be limited to specific apps (`shop-api`, `staging-*` or `*`) and to specific actions (read-only, deploy, config…).

### Two ways to sign in

| | GitHub trust (OIDC) | API token |
|---|---|---|
| Works from | **GitHub Actions only** (github.com, or GitHub Enterprise Server with its own issuer) | anywhere: curl, scripts, other CI systems (GitLab, Jenkins…), dashboards |
| Created with | `dokku api:trust-github <owner/repo>` | `dokku api:token-create <name>` |
| Secret to store | **none** | the token, e.g. as a CI secret |
| Bound to | repository, and optionally environment, branch/tag and workflow file | whoever holds the token |
| Lifetime of what travels | a few minutes per request | until it expires or is revoked |

**The secret-free way only works from GitHub Actions**, because only GitHub issues the ID tokens the server checks. That is the intended main use. For everything else, API tokens remain available and work exactly as before. Both kinds share the same permissions, allow-list, revocation and audit log.

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
- [GitHub Actions without secrets (OIDC)](#github-actions-without-secrets-oidc)
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

- GitHub Actions sign in without any stored secret (OIDC), limited by repository, environment, branch/tag and workflow
- Tokens and trusts scoped per app, with wildcards, and per action (`read`, `logs`, `config:read`, `config:write`, `scale`, `restart`, `deploy`, `cli`)
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

# 2. Expose the API on a domain, with TLS (see "Exposing the API with TLS")
dokku api:setup --domain api.dokku.example.com --ssl-cert … --ssl-key …

# 3. Let the GitHub Actions of a repository deploy one app
dokku api:trust-github my-org/shop-api --app shop-api --scope deploy
```

```yaml
# 4. In my-org/shop-api, .github/workflows/deploy.yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write      # lets the job request its ID token from GitHub
    steps:
      - uses: tiny-tools/dokku-rest-api@v1
        with:
          dokku_url: https://api.dokku.example.com
          app_name: shop-api
          deploy_repository: https://github.com/my-org/shop-api.git
          deploy_ref: ${{ github.sha }}
```

No secret is stored anywhere. For access from outside GitHub Actions, create an [API token](#managing-tokens) instead:

```sh
dokku api:token-create dashboard --app shop-api --scope readonly --expires-in 90d
#    → prints dk_live_… exactly once
curl -s https://api.dokku.example.com/api/v1/apps/shop-api/status -H "Authorization: Bearer dk_live_…"
```

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

`api:setup` validates the generated config with `nginx -t` and restores the previous version if nginx rejects it. It also stores the API's URL (`https://<domain>`) as the `oidc-audience` setting, which [GitHub trusts](#github-actions-without-secrets-oidc) need.

**Behind Cloudflare or another proxy:** deploys run as one long request (often several minutes). Cloudflare's proxy cuts requests after 100 seconds, so point the API's hostname at the server directly (DNS only, no proxy).

## GitHub Actions without secrets (OIDC)

### How it works

1. On the server you trust a repository once: `dokku api:trust-github my-org/shop-api …`. This stores a rule, not a secret.
2. A workflow job with `permissions: id-token: write` asks GitHub for an ID token. It is a JWT signed by GitHub that says which repository, environment, branch or tag and workflow the run belongs to. It expires after a few minutes.
3. The action sends it instead of an API token, and requests a fresh one for every call, because a deploy can outlast a single token.
4. The daemon checks GitHub's signature with GitHub's public keys (`https://token.actions.githubusercontent.com/.well-known/jwks`, cached for an hour), the issuer, the expiry and the audience. Then it looks for a trust that matches the token's claims.
5. From there it is the same as with an API token: the trust's permissions decide which apps and actions are allowed.

The audience is the API's URL (`oidc-audience`, set by `api:setup`). A token minted for one server is therefore useless on another.

### Creating a trust

```sh
dokku api:trust-github <owner/repo> [options]
```

Only the repository is required. `https://github.com/owner/repo.git` can be pasted as is. Everything else is optional:

| Option | Default | Effect |
|---|---|---|
| `--app <pattern> --scope <scopes>` | no permissions | what the trust may do, like `token-create`; repeatable; can also be added later with `api:perm-add` |
| `--environment <name>` | any | only jobs that run in this [GitHub environment](https://docs.github.com/actions/deployment/targeting-different-environments) (`environment: production` in the job); case-insensitive |
| `--branch <glob>` | any | only runs on this branch, e.g. `main` (stored as `refs/heads/main`) |
| `--tag <glob>` | any | only runs for this tag, e.g. `'v*'` (stored as `refs/tags/v*`) |
| `--ref <glob>` | any | a raw ref pattern instead of `--branch`/`--tag`, e.g. `refs/pull/*` |
| `--workflow <file>` | any | only this workflow file, e.g. `deploy.yml` (`.github/workflows/deploy.yml`) |
| `--name <name>` | `github-<repo>[-<environment>]` | the name used by `perm-*`, `trust-revoke` and the audit log |
| `--expires-in <90d>` / `--expires-at <date>` | never | the trust stops working after that |

The command prints the conditions, the permissions and a workflow snippet that fits them.

```sh
# Staging: pushes to main deploy both apps
dokku api:trust-github my-org/shop --environment staging --branch main \
  --app 'shop-*' --scope deploy,read

# Production: only release tags, only from deploy.yml
dokku api:trust-github my-org/shop --environment production --tag 'v*' --workflow deploy.yml \
  --app 'shop-*' --scope deploy,read

dokku api:trust-list                      # conditions, status, last use
dokku api:perm-add github-shop-production --app shop-worker --scope scale
dokku api:trust-revoke github-shop-staging   # takes effect immediately
```

### Rules

- **A trust without conditions applies to every workflow run of the repository**, including runs on feature branches. `trust-github` points this out. For production, use `--environment` and protect that environment in GitHub (Settings → Environments → deployment branches and tags, optionally required reviewers). Anyone who can push a workflow to an allowed branch can deploy, the same as with a stored secret.
- **The repository ID is pinned on first use.** Should the repository be deleted and its name taken again, or be transferred, the trust no longer matches. Create a new trust in that case.
- **The most specific trust wins.** Environment, ref and workflow each count as one condition. If two equally specific trusts match, the request is refused with a message naming both.
- **Pull requests from forks get no ID token from GitHub** and therefore can never use a trust.
- The daemon needs outbound HTTPS to `token.actions.githubusercontent.com`. If GitHub is unreachable and no keys are cached yet, requests fail with `503`.
- **GitHub Enterprise Server:** set `DOKKU_API_GITHUB_OIDC_ISSUER` to its issuer (`https://<host>/_services/token`) in `/etc/default/dokku-api`.

## Managing tokens

API tokens are for everything outside GitHub Actions. All management happens on the host through `dokku api:*`. Run `dokku api:help` for the full list. The `perm-*` commands work for tokens and GitHub trusts alike.

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
- Authentication: `Authorization: Bearer <token>` on every endpoint except `/health`, where `<token>` is an API token (`dk_live_…`) or a GitHub Actions ID token
- Request and response bodies are JSON (`Content-Type: application/json`)
- Errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`

| Status | Meaning |
|--------|---------|
| `400`  | invalid input (app name, body, query) |
| `401`  | token missing, invalid, revoked or expired; or no GitHub trust matches |
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

Without `api_token`, the action signs in as the workflow run via OIDC. That needs `id-token: write` in the job's permissions and a matching [`dokku api:trust-github`](#github-actions-without-secrets-oidc) on the server.

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      packages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/my-org/shop-api:${{ github.sha }}

      - uses: tiny-tools/dokku-rest-api@v1
        with:
          dokku_url: https://api.dokku.example.com
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
| `api_token`         |         | API token (masked in logs); leave it out to sign in via GitHub OIDC |
| `audience`          | origin of `dokku_url` | audience of the OIDC token; must equal the server's `oidc-audience` |
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

To build from source on the server, use `deploy_repository` with `deploy_ref: ${{ github.sha }}`. Dokku then fetches the repository itself (`git:sync --build`). For a private repository, give the server read access once, for example with a fine-grained GitHub token that may only read contents: `dokku git:auth github.com <user> <token>`.

**Using the action from a private copy of this repository:** in that repository, allow access under Settings → Actions → General → Access ("Accessible from repositories in the organization").

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
| `DOKKU_API_GITHUB_OIDC_ISSUER` | `https://token.actions.githubusercontent.com` | only for GitHub Enterprise Server |

After editing the file, apply the change with `sudo systemctl restart dokku-api`.

Settings stored in the database are changed with `dokku api:set <key> [<value>]`: `webhook-url`, `webhook-secret` and `oidc-audience` (the API's URL as GitHub Actions call it; `api:setup` sets it).

## Security model

- **GitHub trusts** store no secret at all. A request is accepted only with an ID token that GitHub signed (RS256, checked against GitHub's published keys), that names this server as its audience, that has not expired, and whose repository (pinned by ID), environment, ref and workflow match a trust.
- **Tokens** are 256-bit random values (`dk_live_…`). Only their SHA-256 hash is stored, and they are shown exactly once.
- **Least privilege:** every request needs a concrete scope on the concrete app. The app list is filtered to what the token may see.
- **No shell:** commands run via `execve` with an argv array, so shell injection is impossible by construction.
- **Validation:** bridge arguments are checked one by one against the allow-list regex. Dokku's global flags (`--app`, `--global`, `--all`, `--trace`) are hard-blocked, and Dokku-specific environment variables are stripped from the child process.
- **Network:** the daemon listens on loopback only. nginx overwrites `X-Forwarded-For`, so the client IPs in the audit log can't be spoofed.
- **Audit:** every authenticated request is logged with token or trust name, path, command, app, status and exit code, but never with config values. Revoking keeps the history.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `dokku api:report` says "not reachable" | `sudo systemctl status dokku-api` and `sudo journalctl -u dokku-api -n 50` |
| `dokku api` is "not a dokku command" | the plugin was installed without `--name api`; reinstall with it |
| Install fails with "Node.js >= 22.13 is required" | install a current Node.js and re-run `sudo dokku plugin:install` |
| `502 Bad Gateway` from nginx | the daemon isn't running, or `DOKKU_API_PORT` differs from the port in the nginx config (re-run `api:setup`) |
| `401` | `dokku api:token-list` shows whether the token is revoked or expired |
| `401 no active trust matches repository …` | `dokku api:trust-list`: compare environment, ref and workflow with the run; the message names the run's environment and ref |
| `401 GitHub OIDC is not set up on this server` | run `dokku api:setup --domain …`, or `dokku api:set oidc-audience https://<domain>` |
| `401 OIDC token audience must be …` | `dokku_url` (or the action's `audience` input) differs from the server's `oidc-audience` |
| Action: `no GitHub OIDC token available` | add `permissions: id-token: write` to the job |
| `503 cannot fetch GitHub's OIDC signing keys` | the server cannot reach `token.actions.githubusercontent.com` |
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
│   ├── oidc.ts           GitHub Actions OIDC: token verification, trust matching
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
