# Security policy

`dokku-rest-api` runs on Dokku hosts with access to the `dokku` command, installs a narrow sudo rule for certbot, and accepts deploys without stored secrets. Please report security issues privately.

## Reporting a vulnerability

Email **team@tinytools.io**, or use GitHub's private vulnerability reporting (Security → Report a vulnerability) if it is enabled for this repository. Please do not open a public issue.

Include what you found, how to reproduce it, and the version (`dokku api:report` shows it). We will confirm receipt and keep you informed until a fix is released.

## Supported versions

Security fixes go into the latest `1.x` release. The action's `@v1` tag always points to it, and `sudo dokku plugin:update api <tag>` updates the plugin.
