# CLAUDE.md

Guidance for working in this repository. User-facing documentation lives in `README.md`.

## What this is

A Dokku plugin (installed as `api`, so commands are `dokku api:*`) plus a GitHub Action, in one repo:

- **Daemon** (`src/server.ts`): a `node:http` server on `127.0.0.1:5099`, run by systemd as the `dokku` user. It offers REST endpoints and a 1:1 CLI bridge, and it executes `/usr/bin/dokku` via `execve`.
- **GitHub OIDC** (`src/oidc.ts`): verifies GitHub Actions ID tokens and maps them to trusts (`dokku api:trust-github`), so CI needs no stored secret.
- **Persistence** (`src/db.ts`): SQLite via the built-in `node:sqlite`, stored at `/var/lib/dokku/data/api/storage.db`.
- **Admin CLI** (`src/admin.ts`): the implementation behind `dokku api:*`.
- **Plugin hooks** (bash, at the repo root): `install`, `uninstall`, `update`, `post-deploy`, `commands`, `subcommands/*`.
- **GitHub Action** (`action.yml` → `dist/action/main.js`, source in `src/action/`).

## Commands

```sh
npm install
npm test             # tsc build + node:test (test/*.test.mjs) against test/fake-dokku.mjs
npm run typecheck
npm run build        # required before committing: dist/ is checked in
shellcheck -x -e SC1091 install uninstall update commands post-deploy bin/dokku-api bin/dokku-api-certbot subcommands/*
```

CI (`.github/workflows/ci.yml`) runs the tests, fails if `dist/` differs from a fresh build, and runs shellcheck.

## Hard constraints

- **No runtime dependencies.** Only `typescript` and `@types/node` as dev dependencies. Use Node built-ins (`node:sqlite`, `node:http`, `fetch`, `node:util` `parseArgs`). The minimum is Node 22.13, the first release with unflagged `node:sqlite`.
- **Commit `dist/`.** The plugin and the action run from a git checkout with no build step. Always run `npm run build` after changing `src/` and commit both.
- **Never use a shell to run dokku.** Always use `runDokku(argv)` from `src/dokku.ts` (`spawn` with an argv array). Don't build command strings.
- **Argv order is `[command, ...flags, app, ...args]`.** Dokku's Go subcommands use `flag.Parse`, which stops at the first positional argument, so flags placed after the app are silently ignored.
- **Keep the global-flag deny list.** `--app`, `--global`, `--all` and `--trace` (`DENIED_ARGS` in `src/allowlist.ts`) are honoured by Dokku's top-level parser anywhere in argv. `--app` would bypass the app scope. `SCRUBBED_ENV` in `src/dokku.ts` exists for the same reason.
- **No destructive features yet.** The user explicitly asked to leave out deleting (no `apps:destroy`, no `config:unset`, no "delete" scope). Ask before adding any.
- **Never store or log secrets.** Only SHA-256 token hashes go in the DB. Config values are sent base64 (`config:set --encoded`), and the echoed command is redacted (`redact: true`). The audit log stores the command name only, never arguments.

## Authorisation model

- Two kinds of principal share the `tokens` table (`kind`): `token` (bearer secret, hash in `token_hash`) and `github` (an OIDC trust; conditions in `github_trusts`, `token_hash` is a random non-hex placeholder that no secret can match). Permissions, allow-list entries, expiry, revocation and the audit log therefore work the same for both. Never let `findTokenBySecret` return a `github` row.
- A bearer value that looks like a JWT goes through `authenticateGithub`: RS256 signature against GitHub's JWKS, `iss`, `aud` = the `oidc-audience` setting (written by `api:setup`), `exp`/`nbf`/`iat` with 60 s leeway. Then `selectTrust` picks the matching trust with the most conditions (environment, ref, workflow); equal matches are refused. `repository_id`/`repository_owner_id` are pinned on first use. `DOKKU_API_GITHUB_OIDC_ISSUER` overrides the issuer (GHES, tests).
- The action requests a fresh ID token per HTTP request, because tokens expire within minutes and a deploy can take longer.
- `token_permissions` holds `(token_id, app_pattern, scope)` rows. App patterns are globs (`shop-*`, `*`). Scopes are defined in `src/scopes.ts`, and aliases (`readonly`, `readwrite`, `all`) are expanded **before** storing.
- Every REST route declares exactly one `scope`, which is checked against the `{app}` path param in `createApiServer`. Routes without an app param that need a scope check it themselves (see `GET /apps`).
- CLI bridge (`authorizeCli`): a matching allow-list entry (global or token-bound), plus the entry's `scope` on the app, plus every argument matching the entry's regex. Entries with `require_app_match = 0` need the scope on the literal pattern `*`.
- `scope` on `cli_allowlist` is an addition to the original spec. Seeded commands map to fine-grained scopes; custom entries default to `cli`.

## Database changes

- Migrations live in the `MIGRATIONS` array in `src/db.ts`, tracked with `PRAGMA user_version`. They are **append-only**: never edit an existing entry, always add a new one.
- `DEFAULT_ALLOWLIST` is only seeded by migration 0. Changing it has **no effect on existing installs**. To ship new default entries, add a migration that inserts them.

## Dokku plugin specifics

- `install` and `uninstall` run as **root** (`plugin:*` commands keep root). Subcommands and `post-deploy` run as the **`dokku` user** (Dokku re-execs itself via sudo), so they cannot touch systemd or write outside `/var/lib/dokku/data/api`.
- For that reason, `api:setup` writes nginx config to `/var/lib/dokku/data/api/nginx/`, which `install` includes from `/etc/nginx/conf.d/dokku-api.conf`. It reloads nginx only through the commands Dokku's sudoers already allows (`nginx -t`, `systemctl reload nginx`).
- `api:setup --letsencrypt` needs root for certbot. `install` copies `bin/dokku-api-certbot` to `/usr/local/sbin` (root-owned, so the dokku user cannot change it) and allows exactly that file in `/etc/sudoers.d/dokku-api`. The helper validates every argument itself and only deletes certificates obtained through the API's webroot. Keep it that narrow.
- `update` runs as root after `plugin:update` (for every plugin, no arguments). `plugn update` discards git's output and reports success even when the fetch or checkout failed, so `update` checks `.plugin_committish` against `HEAD` before it re-runs `install`. Keep `install` idempotent for that reason.
- `uninstall` receives the plugin name as `$1` and is called for every plugin uninstall, so it must check that the name is its own.
- Subcommand wrappers derive the command name from their file name. To add a new `api:<cmd>`, copy one of them, add a `case` in `run()` in `src/admin.ts`, and list it in `HELP`.
- Reference: Dokku's own source (`plugins/*/subcommands`, `plugins/common/functions`) is the best documentation for argument parsing and conventions.

## Tests

- `test/api.test.mjs` starts the real server on a random port with a temp DB and points `DOKKU_API_DOKKU_BIN` at `test/fake-dokku.mjs`. The fake binary logs every argv to `FAKE_DOKKU_LOG`, so tests assert on the exact argv passed to dokku. Every denial test should also assert that `calls()` is empty.
- `test/oidc.test.mjs` signs real RS256 tokens with a generated key and serves the JWKS from a local server (via `DOKKU_API_GITHUB_OIDC_ISSUER`). Add a case there for every new claim check.
- `test/action.test.mjs` covers the action's input parsers (`src/action/lib.ts`). `src/action/main.ts` is the only file with side effects.
- Tests import from `dist/`, so `npm test` always builds first.

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess`, ESM (`"type": "module"`, imports end in `.js`).
- Errors in handlers: throw `HttpError(status, title, detail)`. It is rendered as RFC 9457 `application/problem+json`.
- New REST endpoints: add them to the `routes` array in `src/server.ts`, add tests, and document them in the README endpoint table.
- Bash: Dokku style (`source "$PLUGIN_CORE_AVAILABLE_PATH/common/functions"`, `set -eo pipefail`, `dokku_log_*`), and it must pass shellcheck.
- The version lives in three places, keep them in sync: `package.json`, `plugin.toml`, and `VERSION` in `src/server.ts`.
- Releasing: bump the version (semver) and merge to `main`. After CI passes there, its `release` job tags `v<version>`, moves the major tag (`v1`) that workflows `uses:`, and publishes a GitHub release. Never move a major tag to a breaking change; that needs a new major version.
- Code, comments, commits and docs are in English.
