import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dokku-api-test-"));
const log = join(dir, "dokku.log");
process.env.DOKKU_API_DB = join(dir, "storage.db");
process.env.DOKKU_API_DOKKU_BIN = new URL("./fake-dokku.mjs", import.meta.url).pathname;
process.env.FAKE_DOKKU_LOG = log;

const { Store } = await import("../dist/db.js");
const { createApiServer } = await import("../dist/server.js");
const { run: admin } = await import("../dist/admin.js");

let store;
let server;
let base;
const tokens = {};

async function adminRun(...argv) {
  const lines = [];
  await admin(argv, store, (s) => lines.push(s));
  return lines.join("\n");
}

async function createToken(name, ...grants) {
  const output = await adminRun("token-create", name, ...grants);
  return output.split("\n").find((l) => l.startsWith("dk_live_"));
}

function calls() {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

before(async () => {
  store = new Store();
  tokens.reader = await createToken("reader", "--app", "shop-*", "--scope", "readonly");
  tokens.writer = await createToken("writer", "--app", "shop-api", "--scope", "readwrite");
  tokens.none = await createToken("none");
  tokens.revoked = await createToken("revoked", "--app", "*", "--scope", "all");
  await adminRun("token-revoke", "revoked");
  tokens.expired = await createToken("expired", "--app", "*", "--scope", "all", "--expires-at", "2001-01-01T00:00:00Z");
  server = createApiServer(store);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => writeFileSync(log, ""));

describe("authentication", () => {
  test("health is public", async () => {
    const res = await api("GET", "/api/v1/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });

  test("missing, invalid, revoked and expired tokens are rejected", async () => {
    for (const token of [undefined, "dk_live_nope", tokens.revoked, tokens.expired]) {
      const res = await api("GET", "/api/v1/me", { token });
      assert.equal(res.status, 401, String(token));
      assert.match(res.headers.get("content-type"), /application\/problem\+json/);
      assert.match(res.headers.get("www-authenticate"), /Bearer/);
    }
  });

  test("me shows the token's permissions", async () => {
    const res = await api("GET", "/api/v1/me", { token: tokens.reader });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, "reader");
    assert.deepEqual(
      res.body.permissions.map((p) => `${p.app_pattern}:${p.scope}`).sort(),
      ["shop-*:logs", "shop-*:read"],
    );
  });

  test("unknown routes and wrong methods", async () => {
    assert.equal((await api("GET", "/api/v1/nope", { token: tokens.reader })).status, 404);
    const res = await api("DELETE", "/api/v1/apps/shop-api", { token: tokens.reader });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
  });
});

describe("apps", () => {
  test("list is filtered by app pattern", async () => {
    const res = await api("GET", "/api/v1/apps", { token: tokens.reader });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.apps.map((a) => a.name), ["shop-api", "shop-web"]);
  });

  test("tokens without read scope cannot list", async () => {
    assert.equal((await api("GET", "/api/v1/apps", { token: tokens.none })).status, 403);
  });

  test("report and status", async () => {
    const report = await api("GET", "/api/v1/apps/shop-web", { token: tokens.reader });
    assert.equal(report.status, 200);
    assert.equal(report.body.report.dir, "/home/dokku/shop-web");

    const status = await api("GET", "/api/v1/apps/shop-api/status", { token: tokens.reader });
    assert.equal(status.status, 200);
    assert.equal(status.body.deployed, true);
    assert.equal(status.body.running, true);
    assert.deepEqual(status.body.formation, { web: 2, worker: 1 });
    assert.ok(calls().some((c) => c.join(" ") === "ps:scale --format json shop-api"));
  });

  test("apps outside the pattern are forbidden", async () => {
    assert.equal((await api("GET", "/api/v1/apps/other", { token: tokens.reader })).status, 403);
    assert.equal(calls().length, 0);
  });

  test("missing app maps to 404", async () => {
    const all = await createToken("all-reader", "--app", "*", "--scope", "read");
    assert.equal((await api("GET", "/api/v1/apps/missing", { token: all })).status, 404);
  });

  test("invalid app names are rejected", async () => {
    assert.equal((await api("GET", "/api/v1/apps/..%2Fetc", { token: tokens.reader })).status, 400);
  });
});

describe("formation", () => {
  test("readers cannot scale", async () => {
    const res = await api("PATCH", "/api/v1/apps/shop-api/formation", { token: tokens.reader, body: { web: 3 } });
    assert.equal(res.status, 403);
  });

  test("writers can scale", async () => {
    const res = await api("PATCH", "/api/v1/apps/shop-api/formation?skip_deploy=true", {
      token: tokens.writer,
      body: { web: 3, worker: 0 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls()[0], ["ps:scale", "--skip-deploy", "shop-api", "web=3", "worker=0"]);
  });

  test("the result has the same top-level fields as other commands", async () => {
    const res = await api("PATCH", "/api/v1/apps/shop-api/formation", { token: tokens.writer, body: { web: 1 } });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.exit_code, 0);
    assert.equal(res.body.command_executed, "dokku ps:scale shop-api web=1");
    assert.deepEqual(res.body.execution.stdout, res.body.stdout);
  });

  test("invalid quantities are rejected", async () => {
    for (const body of [{ web: -1 }, { web: "2; rm -rf /" }, { "web;x": 1 }, {}]) {
      const res = await api("PATCH", "/api/v1/apps/shop-api/formation", { token: tokens.writer, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(calls().length, 0);
  });
});

describe("config", () => {
  test("readonly tokens cannot read config", async () => {
    assert.equal((await api("GET", "/api/v1/apps/shop-api/config", { token: tokens.reader })).status, 403);
  });

  test("read all and single values", async () => {
    const all = await api("GET", "/api/v1/apps/shop-api/config", { token: tokens.writer });
    assert.equal(all.status, 200);
    assert.equal(all.body.config.FOO, "bar");
    const one = await api("GET", "/api/v1/apps/shop-api/config/FOO", { token: tokens.writer });
    assert.deepEqual(one.body, { key: "FOO", value: "bar" });
    assert.equal((await api("GET", "/api/v1/apps/shop-api/config/NOPE", { token: tokens.writer })).status, 404);
  });

  test("set uses base64 values and honours restart=false", async () => {
    const value = "multi word $(whoami)\nline";
    const res = await api("PATCH", "/api/v1/apps/shop-api/config?restart=false", {
      token: tokens.writer,
      body: { SECRET: value, N: 8 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.keys, ["SECRET", "N"]);
    assert.doesNotMatch(res.body.execution.command_executed, /SECRET/);
    const [argv] = calls();
    assert.deepEqual(argv.slice(0, 4), ["config:set", "--encoded", "--no-restart", "shop-api"]);
    assert.equal(Buffer.from(argv[4].split("=")[1], "base64").toString(), value);
  });

  test("the result has the same top-level fields as other commands", async () => {
    const res = await api("PATCH", "/api/v1/apps/shop-api/config", { token: tokens.writer, body: { A: "1" } });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.command_executed, "dokku config:set …");
    assert.equal(res.body.execution.ok, true);
  });

  test("put a single value", async () => {
    const res = await api("PUT", "/api/v1/apps/shop-api/config/FOO", { token: tokens.writer, body: { value: "baz" } });
    assert.equal(res.status, 200);
    assert.deepEqual(calls()[0], ["config:set", "--encoded", "shop-api", `FOO=${Buffer.from("baz").toString("base64")}`]);
  });

  test("unset and bad keys are rejected", async () => {
    for (const body of [{ FOO: null }, { "BAD KEY": "x" }, { FOO: { nested: true } }]) {
      const res = await api("PATCH", "/api/v1/apps/shop-api/config", { token: tokens.writer, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("non-JSON bodies are rejected", async () => {
    const res = await fetch(`${base}/api/v1/apps/shop-api/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tokens.writer}`, "Content-Type": "text/plain" },
      body: "FOO=bar",
    });
    assert.equal(res.status, 415);
  });
});

describe("logs, restart, deploy", () => {
  test("logs", async () => {
    const res = await api("GET", "/api/v1/apps/shop-api/logs?lines=50&process=web", { token: tokens.reader });
    assert.equal(res.status, 200);
    assert.equal(res.body.lines.length, 2);
    assert.deepEqual(calls()[0], ["logs", "--num", "50", "--ps", "web", "shop-api"]);
  });

  test("restart one process type", async () => {
    const res = await api("POST", "/api/v1/apps/shop-api/restart", { token: tokens.writer, body: { process: "web" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(calls()[0], ["ps:restart", "shop-api", "web"]);
  });

  test("deploy image, repository and rebuild", async () => {
    await api("POST", "/api/v1/apps/shop-api/deploys", { token: tokens.writer, body: { image: "ghcr.io/a/b:1" } });
    await api("POST", "/api/v1/apps/shop-api/deploys", {
      token: tokens.writer,
      body: { repository: "https://github.com/a/b.git", ref: "main" },
    });
    await api("POST", "/api/v1/apps/shop-api/deploys", { token: tokens.writer });
    assert.deepEqual(calls(), [
      ["git:from-image", "shop-api", "ghcr.io/a/b:1"],
      ["git:sync", "--build", "shop-api", "https://github.com/a/b.git", "main"],
      ["ps:rebuild", "shop-api"],
    ]);
  });

  test("log_tail shortens the returned output", async () => {
    const full = await api("POST", "/api/v1/apps/shop-api/deploys", { token: tokens.writer });
    assert.equal(full.body.stdout.split("\n").length, 6);
    assert.equal(full.body.truncated, undefined);

    const tail = await api("POST", "/api/v1/apps/shop-api/deploys?log_tail=2", { token: tokens.writer });
    assert.equal(tail.status, 200);
    assert.equal(tail.body.stdout, "step 3\n=====> Application deployed\n");
    assert.equal(tail.body.truncated, true);
    assert.equal(tail.body.ok, true);

    const failed = await api("POST", "/api/v1/apps/shop-api/deploys?log_tail=0", { token: tokens.writer, body: { image: "broken:image" } });
    assert.equal(failed.status, 422);
    assert.equal(failed.body.stderr, "");
    assert.equal(failed.body.truncated, true);
  });

  test("an invalid log_tail is refused before dokku runs", async () => {
    for (const value of ["abc", "-1", "1.5", "100001"]) {
      const res = await api("POST", `/api/v1/apps/shop-api/deploys?log_tail=${value}`, { token: tokens.writer });
      assert.equal(res.status, 400, value);
    }
    assert.equal(calls().length, 0);
  });

  test("local repositories and flag-like images are rejected", async () => {
    for (const body of [{ repository: "/var/lib/dokku" }, { repository: "file:///etc" }, { image: "--help" }]) {
      const res = await api("POST", "/api/v1/apps/shop-api/deploys", { token: tokens.writer, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("failed commands return 422 with output", async () => {
    const res = await api("POST", "/api/v1/apps/shop-api/deploys", { token: tokens.writer, body: { image: "broken:image" } });
    assert.equal(res.status, 422);
    assert.equal(res.body.exit_code, 3);
    assert.match(res.body.stderr, /pull failed/);
  });
});

describe("cli bridge", () => {
  test("spec example: flags are moved in front of the app", async () => {
    const res = await api("POST", "/api/v1/cli", {
      token: tokens.writer,
      body: { command: "config:set", app: "shop-api", args: ["--no-restart", "FEATURE=true", "MAX_WORKERS=8"] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.command_executed, "dokku config:set --no-restart shop-api FEATURE=true MAX_WORKERS=8");
    assert.deepEqual(calls()[0], ["config:set", "--no-restart", "shop-api", "FEATURE=true", "MAX_WORKERS=8"]);
  });

  test("path-based passthrough", async () => {
    const res = await api("POST", "/api/v1/apps/shop-api/cli/ps/scale", { token: tokens.writer, body: { args: ["web=1"] } });
    assert.equal(res.status, 200);
    assert.deepEqual(calls()[0], ["ps:scale", "shop-api", "web=1"]);
  });

  test("denied requests never reach dokku", async () => {
    const cases = [
      [{ command: "config:set", app: "shop-api", args: ["--global", "A=1"] }, 403],
      [{ command: "config:set", app: "shop-api", args: ["A=1", "--app", "other"] }, 403],
      [{ command: "ps:scale", app: "shop-api", args: ["web=1", "--app=other"] }, 403],
      [{ command: "config:set", app: "other", args: ["A=1"] }, 403],
      [{ command: "apps:destroy", app: "shop-api", args: ["--force"] }, 403],
      [{ command: "logs", app: "shop-api", args: ["--tail"] }, 403],
      [{ command: "ps:restart", app: "shop-api", args: ["--all"] }, 403],
      [{ command: "config:set", args: ["A=1"] }, 400],
      [{ command: "config:set; rm -rf /", app: "shop-api" }, 400],
      [{ command: "ps:scale", app: "shop-api", args: "web=1" }, 400],
      [{ command: "ps:scale", app: "Shop Api" }, 400],
    ];
    for (const [body, status] of cases) {
      const res = await api("POST", "/api/v1/cli", { token: tokens.writer, body });
      assert.equal(res.status, status, JSON.stringify(body));
    }
    assert.equal(calls().length, 0);
  });

  test("scopes apply to bridge commands", async () => {
    const res = await api("POST", "/api/v1/cli", {
      token: tokens.reader,
      body: { command: "config:set", app: "shop-api", args: ["A=1"] },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.detail, /config:write/);
    const ok = await api("POST", "/api/v1/cli", { token: tokens.reader, body: { command: "ps:report", app: "shop-web" } });
    assert.equal(ok.status, 200);
  });

  test("custom allow-list entries need the cli scope and can be token-specific", async () => {
    const custom = await createToken("custom", "--app", "db-*", "--scope", "cli");
    await adminRun("allowlist-add", "postgres:info", "--flags", "^--[a-z-]+$", "--token", "custom");
    const ok = await api("POST", "/api/v1/cli", { token: custom, body: { command: "postgres:info", app: "db-main" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls()[0], ["postgres:info", "db-main"]);
    const other = await api("POST", "/api/v1/cli", { token: tokens.writer, body: { command: "postgres:info", app: "shop-api" } });
    assert.equal(other.status, 403);
  });

  test("allowlist endpoint lists usable commands", async () => {
    const res = await api("GET", "/api/v1/allowlist", { token: tokens.reader });
    const commands = res.body.commands.map((c) => c.command);
    assert.ok(commands.includes("ps:report"));
    assert.ok(commands.includes("logs"));
    assert.ok(!commands.includes("config:set"));
  });

  test("requests are audited without config values", () => {
    const rows = store.listAudit(500);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => !String(r.command ?? "").includes("=")));
  });
});

describe("admin cli", () => {
  test("aliases are expanded and duplicate names refused", async () => {
    await createToken("alias", "--app", "x", "--scope", "readwrite");
    const scopes = store.listPermissions(store.getTokenByName("alias").id).map((p) => p.scope).sort();
    assert.deepEqual(scopes, ["config:read", "config:write", "deploy", "logs", "read", "restart", "scale"]);
    await assert.rejects(adminRun("token-create", "alias"), /already exists/);
    await assert.rejects(adminRun("perm-add", "alias", "--app", "x", "--scope", "delete"), /unknown scope/);
  });

  test("token-create can print only the token or JSON", async () => {
    const quiet = await adminRun("token-create", "quiet", "--app", "x", "--scope", "read", "--quiet");
    assert.match(quiet, /^dk_live_[A-Za-z0-9_-]{43}$/);
    const json = JSON.parse(await adminRun("token-create", "json", "--app", "x", "--scope", "deploy", "--expires-in", "1d", "--format", "json"));
    assert.equal(json.name, "json");
    assert.match(json.token, /^dk_live_/);
    assert.ok(Date.parse(json.expires_at) > Date.now());
    assert.deepEqual(json.permissions, [{ app_pattern: "x", scope: "deploy" }]);
    const me = await api("GET", "/api/v1/me", { token: json.token });
    assert.equal(me.body.name, "json");
    await assert.rejects(adminRun("token-create", "bad", "--format", "yaml"), /json/);
    await assert.rejects(adminRun("token-create", "bad", "--quiet", "--format", "json"), /either/);
  });

  test("token secrets are stored hashed", async () => {
    const secret = await createToken("hashed");
    const row = store.db.prepare("SELECT token_hash FROM tokens WHERE name = 'hashed'").get();
    assert.notEqual(row.token_hash, secret);
    assert.equal(row.token_hash.length, 64);
  });
});
