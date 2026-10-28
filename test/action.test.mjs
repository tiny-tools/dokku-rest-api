import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliCommands, parseConfig, parseScale } from "../dist/action/lib.js";

test("parseConfig", () => {
  assert.deepEqual(parseConfig("# comment\nA=1\n\nB = 'two words'\nC=x=y\n"), { A: "1", B: " 'two words'", C: "x=y" });
  assert.deepEqual(parseConfig("B='two words'"), { B: "two words" });
  assert.throws(() => parseConfig("NOPE"));
});

test("parseScale", () => {
  assert.deepEqual(parseScale("web=2 worker=1"), { web: 2, worker: 1 });
  assert.deepEqual(parseScale("web=2\nworker=0"), { web: 2, worker: 0 });
  assert.throws(() => parseScale("web=two"));
});

test("parseCliCommands", () => {
  const parsed = parseCliCommands('["ps:scale", "web=2", "worker=1"]\n["config:set", "--no-restart", "SHA=abc"]\n{"command": "ps:report", "app": "x"}', "my-app");
  assert.deepEqual(parsed, [
    { command: "ps:scale", app: "my-app", args: ["web=2", "worker=1"] },
    { command: "config:set", app: "my-app", args: ["--no-restart", "SHA=abc"] },
    { command: "ps:report", app: "x" },
  ]);
  assert.throws(() => parseCliCommands("ps:scale web=2", "a"));
});

test("requestIdToken asks GitHub for the audience", async () => {
  const { createServer } = await import("node:http");
  const { requestIdToken } = await import("../dist/action/lib.js");
  let seen;
  const server = createServer((req, res) => {
    seen = { url: new URL(req.url, "http://x"), auth: req.headers.authorization };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ value: "a.b.c" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const env = { ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${server.address().port}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner" };
    assert.equal(await requestIdToken("https://api.example.com", env), "a.b.c");
    assert.equal(seen.url.searchParams.get("audience"), "https://api.example.com");
    assert.equal(seen.url.searchParams.get("api-version"), "2.0");
    assert.equal(seen.auth, "Bearer runner");
    await assert.rejects(requestIdToken("https://api.example.com", {}), /id-token: write/);
  } finally {
    server.close();
  }
});

test("withRetries retries dokku and server failures only", async () => {
  const { ApiError, withRetries } = await import("../dist/action/lib.js");
  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);
  const failing = (errors) => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (errors.length) throw errors.shift();
      return "ok";
    };
    return { fn, calls: () => calls };
  };

  const flaky = failing([new ApiError("build broke", {}, 422), new ApiError("bad gateway", {}, 502)]);
  assert.equal(await withRetries(flaky.fn, 2, 5000, undefined, sleep), "ok");
  assert.equal(flaky.calls(), 3);
  assert.deepEqual(sleeps, [5000, 5000]);

  const exhausted = failing([new ApiError("a", {}, 422), new ApiError("b", {}, 422)]);
  await assert.rejects(withRetries(exhausted.fn, 1, 0, undefined, sleep), /b/);
  assert.equal(exhausted.calls(), 2);

  for (const err of [new ApiError("forbidden", {}, 403), new ApiError("bad", {}, 400), Object.assign(new Error("t"), { name: "TimeoutError" })]) {
    const once = failing([err]);
    await assert.rejects(withRetries(once.fn, 3, 0, undefined, sleep));
    assert.equal(once.calls(), 1, err.message);
  }

  const network = failing([Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })]);
  assert.equal(await withRetries(network.fn, 1, 0, undefined, sleep), "ok");
  assert.equal(network.calls(), 2);

  const none = failing([new ApiError("a", {}, 422)]);
  await assert.rejects(withRetries(none.fn, 0, 0, undefined, sleep));
  assert.equal(none.calls(), 1);
});

async function serve(handler) {
  const { createServer } = await import("node:http");
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("httpExchange waits for late headers up to its own timeout", async () => {
  const { httpExchange, isRetryable } = await import("../dist/action/lib.js");
  // Response headers only after 1.5 s, like a synchronous deploy (fetch gives up after 300 s).
  const slow = await serve((req, res) => setTimeout(() => res.writeHead(200).end("done"), 1500));
  try {
    const ok = await httpExchange(new URL(slow.url), { method: "POST", headers: {}, body: "{}", timeoutMs: 5000 });
    assert.deepEqual(ok, { status: 200, text: "done" });
    await assert.rejects(httpExchange(new URL(slow.url), { method: "GET", headers: {}, timeoutMs: 300 }), (err) => {
      assert.equal(err.name, "TimeoutError");
      assert.equal(isRetryable(err), false);
      return true;
    });
  } finally {
    slow.close();
  }
  const closed = await serve(() => {});
  closed.close();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(httpExchange(new URL(closed.url), { method: "GET", headers: {}, timeoutMs: 1000 }), (err) => {
    assert.equal(err.code, "ECONNREFUSED");
    assert.equal(isRetryable(err), true);
    return true;
  });
});

test("waitForHealthy polls until the app answers with the expected content", async () => {
  const { waitForHealthy } = await import("../dist/action/lib.js");
  let hits = 0;
  const app = await serve((req, res) => {
    hits++;
    if (hits < 3) return res.writeHead(503).end("starting");
    res.writeHead(200).end('{"version":"abc123"}');
  });
  const lines = [];
  const noSleep = async () => {};
  try {
    assert.equal(await waitForHealthy(`${app.url}/version`, { contains: "abc123", timeoutMs: 10_000, log: (l) => lines.push(l) }, noSleep), 3);
    assert.deepEqual(lines, ["attempt 1: HTTP 503", "attempt 2: HTTP 503"]);
    await assert.rejects(
      waitForHealthy(app.url, { contains: "def456", timeoutMs: 300, intervalMs: 50 }),
      /failed after \d+ attempt\(s\): response does not contain "def456"/,
    );
  } finally {
    app.close();
  }
});
