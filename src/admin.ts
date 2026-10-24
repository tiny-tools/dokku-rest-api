// Host-side administration, invoked through `dokku api:<command>`.
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { Store } from "./db.js";
import { APP_PATTERN_RE, expandScopes, isScope, SCOPE_ALIASES, SCOPES } from "./scopes.js";

const SETTINGS = {
  "webhook-url": "URL that receives a JSON POST after every app deploy",
  "webhook-secret": "Secret used to sign webhook payloads (X-Dokku-Api-Signature: sha256=<hmac>)",
} as const;

export const HELP = `Usage: dokku api[:COMMAND]

Manage the Dokku REST API

Additional commands:
    api:setup [--domain <domain>] [--ssl-cert <path> --ssl-key <path>]  Expose the API through nginx
    api:report                                                         Show daemon, database and settings status
    api:token-create <name> [--app <pattern> --scope <scopes>]... [--expires-in <30d|12h>]
                                                                       Create a token (printed once)
    api:token-list                                                     List tokens
    api:token-revoke <name>                                            Revoke a token immediately
    api:perm-add <name> --app <pattern> --scope <scopes>               Grant scopes on apps matching <pattern>
    api:perm-remove <name> --app <pattern> --scope <scopes>            Remove granted scopes
    api:perm-list [<name>]                                             List permissions
    api:allowlist-add <command> [--flags <regex>] [--scope <scope>] [--token <name>] [--no-app] [--description <text>]
                                                                       Allow a dokku command on the CLI bridge
    api:allowlist-list                                                 List allow-listed commands
    api:allowlist-remove <id>                                          Remove an allow-list entry
    api:audit [--limit <n>]                                            Show recent API requests
    api:set <key> [<value>]                                            Set or clear a setting (${Object.keys(SETTINGS).join(", ")})

Scopes: ${Object.keys(SCOPES).join(", ")}
Aliases: ${Object.entries(SCOPE_ALIASES)
  .map(([k, v]) => `${k} (${v.join(",")})`)
  .join(", ")}`;

class UsageError extends Error {}

function table(rows: object[], columns: string[]): string {
  if (rows.length === 0) return "(none)";
  const cell = (v: unknown) => (v === null || v === undefined ? "-" : String(v));
  const get = (r: object, c: string) => cell((r as Record<string, unknown>)[c]);
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => get(r, c).length)));
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map((c) => get(r, c))))].join("\n");
}

function parseDuration(input: string): number {
  const m = /^(\d+)([mhdw])$/.exec(input);
  if (!m) throw new UsageError(`invalid duration "${input}" (use e.g. 30m, 12h, 90d, 4w)`);
  const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2] as "m" | "h" | "d" | "w"];
  return Number(m[1]) * unit;
}

function requireToken(store: Store, name: string | undefined) {
  if (!name) throw new UsageError("missing token name");
  const token = store.getTokenByName(name);
  if (!token) throw new UsageError(`token "${name}" does not exist`);
  return token;
}

function checkPattern(pattern: string): string {
  if (!APP_PATTERN_RE.test(pattern)) throw new UsageError(`invalid app pattern "${pattern}"`);
  return pattern;
}

// Pairs repeated --app/--scope options: one --scope applies to every --app,
// otherwise they are matched by position.
function grants(apps: string[], scopes: string[]): [string, string][] {
  if (apps.length === 0 && scopes.length === 0) return [];
  if (apps.length === 0 || scopes.length === 0) throw new UsageError("--app and --scope must be given together");
  if (scopes.length !== 1 && scopes.length !== apps.length) {
    throw new UsageError("give either one --scope for all --app options or one --scope per --app");
  }
  return apps.map((a, i) => [checkPattern(a), scopes.length === 1 ? scopes[0]! : scopes[i]!]);
}

async function report(store: Store): Promise<string> {
  const host = process.env.DOKKU_API_HOST || "127.0.0.1";
  const port = process.env.DOKKU_API_PORT || "5099";
  let daemon = "not reachable";
  try {
    const res = await fetch(`http://${host}:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { status?: string; version?: string };
    daemon = `${body.status} (version ${body.version})`;
  } catch {
    /* keep "not reachable" */
  }
  const tokens = store.listTokens();
  const lines = [
    `=====> api report`,
    `       Daemon:            ${daemon} on http://${host}:${port}`,
    `       Database:          ${process.env.DOKKU_API_DB || "/var/lib/dokku/data/api/storage.db"}`,
    `       Active tokens:     ${tokens.filter((t) => !t.revoked).length} (${tokens.length} total)`,
    `       Allow-list rules:  ${store.listAllowlist().length}`,
  ];
  for (const key of Object.keys(SETTINGS)) {
    const value = store.getSetting(key);
    lines.push(`       ${(key + ":").padEnd(19)}${value === undefined ? "-" : key.endsWith("secret") ? "(set)" : value}`);
  }
  return lines.join("\n");
}

export async function run(argv: string[], store: Store, out: (s: string) => void = console.log): Promise<void> {
  const [command, ...rest] = argv;
  const opts = (options: ParseArgsOptionsConfig) =>
    parseArgs({ args: rest, options, allowPositionals: true, strict: true });

  switch (command) {
    case undefined:
    case "help":
    case "default":
      out(HELP);
      return;

    case "migrate":
      return;

    case "report":
      out(await report(store));
      return;

    case "token-create": {
      const { values, positionals } = opts({
        app: { type: "string", multiple: true },
        scope: { type: "string", multiple: true },
        "expires-in": { type: "string" },
        "expires-at": { type: "string" },
      });
      const name = positionals[0];
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new UsageError("missing or invalid token name");
      if (store.getTokenByName(name)) throw new UsageError(`token "${name}" already exists`);
      const pairs = grants((values.app as string[]) ?? [], (values.scope as string[]) ?? []);
      pairs.forEach(([, s]) => expandScopes(s));
      let expiresAt: string | null = null;
      if (values["expires-in"]) expiresAt = new Date(Date.now() + parseDuration(values["expires-in"] as string)).toISOString();
      if (values["expires-at"]) {
        const ts = Date.parse(values["expires-at"] as string);
        if (Number.isNaN(ts)) throw new UsageError("invalid --expires-at");
        expiresAt = new Date(ts).toISOString();
      }
      const { token, row } = store.createToken(name, expiresAt);
      for (const [app, scopes] of pairs) for (const s of expandScopes(scopes)) store.addPermission(row.id, app, s);
      out(`=====> Created token "${name}"${expiresAt ? ` (expires ${expiresAt})` : ""}`);
      out(`       Store it now, it will not be shown again:`);
      out("");
      out(token);
      out("");
      if (pairs.length === 0) out(`       Grant access with: dokku api:perm-add ${name} --app <app> --scope readonly`);
      return;
    }

    case "token-list": {
      const now = Date.now();
      const rows = store.listTokens().map((t) => ({
        ...t,
        status: t.revoked ? "revoked" : t.expires_at && Date.parse(t.expires_at) <= now ? "expired" : "active",
      }));
      out(table(rows, ["name", "token_prefix", "status", "created_at", "expires_at", "last_used_at"]));
      return;
    }

    case "token-revoke": {
      const token = requireToken(store, rest[0]);
      store.revokeToken(token.id);
      out(`=====> Revoked token "${token.name}"`);
      return;
    }

    case "perm-add":
    case "perm-remove": {
      const { values, positionals } = opts({ app: { type: "string", multiple: true }, scope: { type: "string", multiple: true } });
      const token = requireToken(store, positionals[0]);
      const pairs = grants((values.app as string[]) ?? [], (values.scope as string[]) ?? []);
      if (pairs.length === 0) throw new UsageError("missing --app and --scope");
      for (const [app, scopes] of pairs) {
        for (const s of expandScopes(scopes)) {
          if (command === "perm-add") store.addPermission(token.id, app, s);
          else store.removePermission(token.id, app, s);
        }
      }
      out(table(store.listPermissions(token.id), ["token_name", "app_pattern", "scope"]));
      return;
    }

    case "perm-list": {
      const token = rest[0] ? requireToken(store, rest[0]) : undefined;
      out(table(store.listPermissions(token?.id), ["token_name", "app_pattern", "scope"]));
      return;
    }

    case "allowlist-add": {
      const { values, positionals } = opts({
        flags: { type: "string" },
        scope: { type: "string" },
        token: { type: "string" },
        "no-app": { type: "boolean" },
        description: { type: "string" },
      });
      const cmd = positionals[0];
      if (!cmd || !/^[a-z0-9*][a-z0-9*-]*(:[a-z0-9*][a-z0-9*-]*)?$/.test(cmd)) throw new UsageError("missing or invalid command");
      const flags = (values.flags as string | undefined) ?? "^.*$";
      try {
        new RegExp(flags, "s");
      } catch {
        throw new UsageError(`invalid regex "${flags}"`);
      }
      const scope = (values.scope as string | undefined) ?? "cli";
      if (!isScope(scope)) throw new UsageError(`unknown scope "${scope}"`);
      const token = values.token ? requireToken(store, values.token as string) : undefined;
      const id = store.addAllowlistEntry({
        token_id: token?.id ?? null,
        command_prefix: cmd,
        allowed_flags_regex: flags,
        require_app_match: values["no-app"] ? 0 : 1,
        scope,
        description: (values.description as string | undefined) ?? null,
      });
      out(`=====> Added allow-list entry #${id} for "${cmd}" (scope ${scope})`);
      return;
    }

    case "allowlist-list": {
      const rows = store.listAllowlist().map((e) => ({
        ...e,
        token: e.token_name ?? "*",
        app: e.require_app_match ? "yes" : "no",
      }));
      out(table(rows, ["id", "command_prefix", "scope", "app", "token", "allowed_flags_regex", "description"]));
      return;
    }

    case "allowlist-remove": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new UsageError("missing allow-list entry id");
      if (store.removeAllowlistEntry(id) === 0) throw new UsageError(`allow-list entry #${id} does not exist`);
      out(`=====> Removed allow-list entry #${id}`);
      return;
    }

    case "audit": {
      const { values } = opts({ limit: { type: "string" } });
      const limit = Number(values.limit ?? 50);
      out(table(store.listAudit(limit).reverse(), ["created_at", "token", "method", "path", "command", "app", "status", "exit_code", "remote_addr"]));
      return;
    }

    case "set": {
      const [key, value] = rest;
      if (!key || !Object.hasOwn(SETTINGS, key)) throw new UsageError(`unknown setting (valid: ${Object.keys(SETTINGS).join(", ")})`);
      store.setSetting(key, value ?? null);
      out(value ? `=====> Set ${key}` : `=====> Cleared ${key}`);
      return;
    }

    default:
      throw new UsageError(`unknown command "${command}", see: dokku api:help`);
  }
}

export async function main(): Promise<void> {
  const store = new Store();
  try {
    await run(process.argv.slice(2), store);
  } catch (err) {
    console.error(` !     ${err instanceof Error ? err.message : String(err)}`);
    if (process.env.DOKKU_TRACE && err instanceof Error) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
