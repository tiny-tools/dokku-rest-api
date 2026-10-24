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
