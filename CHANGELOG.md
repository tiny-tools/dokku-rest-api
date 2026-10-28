# Changelog

All notable changes. Versions follow [semantic versioning](https://semver.org/); the GitHub Action's `@v1` tag always points to the latest 1.x release. The release job publishes the section of each version as its release notes.

## 1.2.1

- Prepared for GitHub Marketplace: `LICENSE` (MIT), `SECURITY.md`, this changelog, and a README that starts with the action.
- Releases carry their notes from this changelog.

## 1.2.0

- The action no longer uses `fetch` for API calls. Node's `fetch` gave up after 300 s without response headers, so synchronous deploys longer than five minutes failed in the action. `timeout_seconds` is now the only limit.
- Optional health check after all steps: `health_check_url`, `health_check_contains` (e.g. the commit SHA), `health_check_timeout`. Without a URL nothing is checked.
- New `update` trigger: after `dokku plugin:update api <tag>` it checks that the tag is really checked out, shows git's error if not, and otherwise migrates the database and restarts the daemon. `plugin:install` is no longer needed after an update.
- `dokku api:report` shows the plugin version and warns when the daemon still runs older code.

## 1.1.0

- `dokku api:setup --letsencrypt [--email] [--delete-old-cert]`: TLS with Let's Encrypt in one step, through a root-owned certbot helper with a narrow sudo rule.
- `api:setup` reports a missing certificate file up front and otherwise shows nginx's own error.
- `dokku api:deploy-key [<owner>/<repo>]` creates the SSH key `git:sync` uses for a private GitHub repository.
- `dokku api:token-create --quiet | --format json` for scripting.
- `?log_tail=N` on every endpoint that runs a command.
- One response format: formation and config return the command result at the top level (`execution` remains until 2.0).
- Action: `deploy_retries` and `deploy_retry_delay`.

## 1.0.0

- Secret-free deploys from GitHub Actions: `dokku api:trust-github <owner/repo>` with optional environment, branch/tag/ref, workflow and expiry, verified via GitHub OIDC.
- REST API with tokens scoped per app and action, CLI bridge with an allow-list, audit log, webhook after deploys.
- GitHub Action for config, deploys (image, git, rebuild), scaling, restarts and CLI commands.
