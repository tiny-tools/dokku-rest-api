import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dokku-api-oidc-"));
const log = join(dir, "dokku.log");
process.env.DOKKU_API_DB = join(dir, "storage.db");
process.env.DOKKU_API_DOKKU_BIN = new URL("./fake-dokku.mjs", import.meta.url).pathname;
process.env.FAKE_DOKKU_LOG = log;

const { Store } = await import("../dist/db.js");
const { createApiServer } = await import("../dist/server.js");
const { run: admin } = await import("../dist/admin.js");

const AUDIENCE = "https://api.example.com";
const github = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });

let store;
let server;
let jwks;
let base;
let issuer;

async function adminRun(...argv) {
  const lines = [];
  await admin(argv, store, (s) => lines.push(s));
  return lines.join("\n");
}

function calls() {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

// A GitHub Actions ID token for tiny-tools/shop, overridable per test.
function idToken(claims = {}, { key = github.privateKey, kid = "k1", alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: AUDIENCE,
    iat: now,
    nbf: now,
    exp: now + 300,
    repository: "tiny-tools/shop",
    repository_id: "100",
    repository_owner_id: "7",
    ref: "refs/heads/main",
    workflow_ref: "tiny-tools/shop/.github/workflows/deploy.yml@refs/heads/main",
    ...claims,
  };
  for (const [k, v] of Object.entries(payload)) if (v === undefined) delete payload[k];
  const signed = `${b64({ alg, kid, typ: "JWT" })}.${b64(payload)}`;
  const signature = createSign("RSA-SHA256").update(signed).sign(key).toString("base64url");
  return `${signed}.${signature}`;
}

async function api(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  jwks = createServer((req, res) => {
    if (req.url !== "/.well-known/jwks") return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [{ ...github.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] }));
  });
  await new Promise((r) => jwks.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${jwks.address().port}`;
  process.env.DOKKU_API_GITHUB_OIDC_ISSUER = issuer;

  store = new Store();
  await adminRun("set", "oidc-audience", AUDIENCE);
  await adminRun("trust-github", "tiny-tools/shop", "--environment", "production", "--app", "shop-*", "--scope", "read,deploy");
  server = createApiServer(store);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  jwks.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => writeFileSync(log, ""));

describe("github oidc", () => {
  test("a matching workflow run can deploy without any secret", async () => {
    const token = idToken({ environment: "production" });
    const me = await api("GET", "/api/v1/me", token);
    assert.equal(me.status, 200);
    assert.equal(me.body.name, "github-shop-production");
    assert.equal(me.body.kind, "github");
    assert.deepEqual(me.body.github, { repository: "tiny-tools/shop", environment: "production", ref: null, workflow: null });

    const res = await api("POST", "/api/v1/apps/shop-api/deploys", token, {
      repository: "https://github.com/tiny-tools/shop.git",
      ref: "abc123",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls(), [["git:sync", "--build", "shop-api", "https://github.com/tiny-tools/shop.git", "abc123"]]);
  });

  test("scopes and app patterns still apply", async () => {
    const token = idToken({ environment: "production" });
    assert.equal((await api("POST", "/api/v1/apps/other/deploys", token, {})).status, 403);
    assert.equal((await api("PATCH", "/api/v1/apps/shop-api/config", token, { A: "1" })).status, 403);
    assert.equal(calls().length, 0);
  });

  test("other environments, repositories and invalid tokens are rejected", async () => {
    const cases = {
      "no environment": idToken(),
      "other environment": idToken({ environment: "staging" }),
      "other repository": idToken({ environment: "production", repository: "tiny-tools/other" }),
      "wrong audience": idToken({ environment: "production", aud: "https://elsewhere.example.com" }),
      "wrong issuer": idToken({ environment: "production", iss: "https://evil.example.com" }),
      expired: idToken({ environment: "production", exp: Math.floor(Date.now() / 1000) - 600 }),
      "not yet valid": idToken({ environment: "production", nbf: Math.floor(Date.now() / 1000) + 600 }),
      "foreign signature": idToken({ environment: "production" }, { key: attacker.privateKey }),
      "unknown key": idToken({ environment: "production" }, { kid: "k2" }),
      "other algorithm": idToken({ environment: "production" }, { alg: "HS256" }),
      "missing repository_id": idToken({ environment: "production", repository_id: undefined }),
      malformed: "eyJhbGciOi.bm9wZQ.c2ln",
    };
    for (const [name, token] of Object.entries(cases)) {
      const res = await api("POST", "/api/v1/apps/shop-api/deploys", token, {});
      assert.equal(res.status, 401, name);
    }
    assert.equal(calls().length, 0);
  });

  test("environment names are case-insensitive", async () => {
    assert.equal((await api("GET", "/api/v1/me", idToken({ environment: "Production" }))).status, 200);
  });

  test("the repository id is pinned on first use", async () => {
    const trust = store.listGithubTrusts("tiny-tools/shop").find((t) => t.name === "github-shop-production");
    assert.equal(trust.repository_id, "100");
    assert.equal(trust.repository_owner_id, "7");
    // Same name, but a different repository (deleted and recreated, or transferred).
    const res = await api("GET", "/api/v1/me", idToken({ environment: "production", repository_id: "999" }));
    assert.equal(res.status, 401);
  });

  test("tag and workflow conditions", async () => {
    await adminRun("trust-github", "https://github.com/tiny-tools/lib.git", "--tag", "v*", "--workflow", "release.yml", "--app", "lib", "--scope", "deploy");
    const claims = {
      repository: "tiny-tools/lib",
      repository_id: "200",
      ref: "refs/tags/v1.2.3",
      workflow_ref: "tiny-tools/lib/.github/workflows/release.yml@refs/tags/v1.2.3",
    };
    assert.equal((await api("GET", "/api/v1/me", idToken(claims))).body.name, "github-lib");
    assert.equal((await api("GET", "/api/v1/me", idToken({ ...claims, ref: "refs/heads/main" }))).status, 401);
    const otherWorkflow = { ...claims, workflow_ref: "tiny-tools/lib/.github/workflows/ci.yml@refs/tags/v1.2.3" };
    assert.equal((await api("GET", "/api/v1/me", idToken(otherWorkflow))).status, 401);
  });

  test("the most specific trust wins, equal ones are refused", async () => {
    await adminRun("trust-github", "tiny-tools/multi", "--app", "multi", "--scope", "read");
    await adminRun("trust-github", "tiny-tools/multi", "--environment", "production", "--app", "multi", "--scope", "deploy");
    const claims = { repository: "tiny-tools/multi", repository_id: "300" };
    assert.equal((await api("GET", "/api/v1/me", idToken(claims))).body.name, "github-multi");
    assert.equal((await api("GET", "/api/v1/me", idToken({ ...claims, environment: "production" }))).body.name, "github-multi-production");

    await adminRun("trust-github", "tiny-tools/multi", "--branch", "main", "--name", "multi-main");
    const res = await api("GET", "/api/v1/me", idToken({ ...claims, environment: "production" }));
    assert.equal(res.status, 401);
    assert.match(res.body.detail, /both match/);
  });

  test("revoked trusts and a missing audience setting are rejected", async () => {
    await adminRun("trust-github", "tiny-tools/gone", "--app", "gone", "--scope", "read");
    const token = idToken({ repository: "tiny-tools/gone", repository_id: "400" });
    assert.equal((await api("GET", "/api/v1/me", token)).status, 200);
    await adminRun("trust-revoke", "github-gone");
    assert.equal((await api("GET", "/api/v1/me", token)).status, 401);

    await adminRun("set", "oidc-audience");
    try {
      const res = await api("GET", "/api/v1/me", idToken({ environment: "production" }));
      assert.equal(res.status, 401);
      assert.match(res.body.detail, /api:setup/);
    } finally {
      await adminRun("set", "oidc-audience", AUDIENCE);
    }
  });

  test("requests are audited under the trust's name", () => {
    assert.ok(store.listAudit(500).some((r) => r.token === "github-shop-production" && r.command === "git:sync"));
  });
});

describe("admin cli", () => {
  test("trust-github prints the conditions and a workflow snippet", async () => {
    const output = await adminRun("trust-github", "tiny-tools/web", "--environment", "staging", "--branch", "main", "--app", "web", "--scope", "deploy");
    assert.match(output, /Trusting GitHub Actions of tiny-tools\/web as "github-web-staging"/);
    assert.match(output, /Ref: +refs\/heads\/main/);
    assert.match(output, /Permissions: +web \(deploy\)/);
    assert.match(output, /environment: staging/);
    assert.match(output, /id-token: write/);
    assert.match(output, new RegExp(`dokku_url: ${AUDIENCE}`));
    assert.match(output, /app_name: web/);
  });

  test("everything but the repository is optional", async () => {
    const output = await adminRun("trust-github", "tiny-tools/bare");
    assert.match(output, /Grant access with: dokku api:perm-add github-bare/);
    assert.match(output, /every workflow run/);
    await adminRun("perm-add", "github-bare", "--app", "bare", "--scope", "readonly");
    assert.deepEqual(store.listPermissions(store.getTokenByName("github-bare").id).map((p) => p.scope).sort(), ["logs", "read"]);
  });

  test("invalid input is refused", async () => {
    await assert.rejects(adminRun("trust-github"), /owner>\/<repo/);
    await assert.rejects(adminRun("trust-github", "not-a-repo"), /owner>\/<repo/);
    await assert.rejects(adminRun("trust-github", "a/b", "--branch", "main", "--tag", "v*"), /only one of/);
    await assert.rejects(adminRun("trust-github", "a/b", "--workflow", "deploy.sh"), /--workflow/);
    await assert.rejects(adminRun("trust-github", "tiny-tools/web", "--environment", "staging"), /already exists/);
  });

  test("tokens and trusts are listed separately", async () => {
    await adminRun("token-create", "plain", "--app", "x", "--scope", "read");
    const tokens = await adminRun("token-list");
    assert.match(tokens, /plain/);
    assert.doesNotMatch(tokens, /github-/);
    const trusts = await adminRun("trust-list");
    assert.match(trusts, /github-shop-production +tiny-tools\/shop +production/);
    assert.doesNotMatch(trusts, /plain/);
    await assert.rejects(adminRun("trust-revoke", "plain"), /not a GitHub trust/);
  });
});
