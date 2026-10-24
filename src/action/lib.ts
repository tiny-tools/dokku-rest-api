// GitHub Action: talks to the dokku-api daemon. Dependency-free on purpose;
// inputs come from INPUT_* env vars and outputs go to $GITHUB_OUTPUT.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function input(name: string, fallback = ""): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim() || fallback;
}

function boolInput(name: string, fallback: boolean): boolean {
  const value = input(name).toLowerCase();
  if (value === "") return fallback;
  if (["true", "yes", "1", "on"].includes(value)) return true;
  if (["false", "no", "0", "off"].includes(value)) return false;
  throw new Error(`input "${name}" must be true or false`);
}

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `ghadelim_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

const group = (title: string) => console.log(`::group::${title}`);
const endGroup = () => console.log("::endgroup::");
export const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export interface Execution {
  ok?: boolean;
  exit_code?: number;
  command_executed?: string;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class Client {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "User-Agent": "dokku-api-action",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      const detail = [parsed.title, parsed.detail].filter(Boolean).join(": ") || text.slice(0, 500);
      throw new ApiError(`${method} ${path} failed with HTTP ${res.status}: ${detail}`, parsed);
    }
    return parsed;
  }
}

export function printExecution(e: Execution | undefined): void {
  if (!e) return;
  if (e.command_executed) console.log(`$ ${e.command_executed}`);
  if (e.stdout) console.log(e.stdout.trimEnd());
  if (e.stderr) console.log(e.stderr.trimEnd());
  if (e.duration_ms !== undefined) console.log(`(exit ${e.exit_code}, ${e.duration_ms} ms)`);
}

// "KEY=value" per line; blank lines and lines starting with # are ignored.
export function parseConfig(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`invalid config line "${line}", expected KEY=value`);
    let value = line.slice(eq + 1);
    if (/^(['"]).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    vars[line.slice(0, eq).trim()] = value;
  }
  return vars;
}

// "web=2 worker=1" or one tuple per line.
export function parseScale(text: string): Record<string, number> {
  const formation: Record<string, number> = {};
  for (const tuple of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^([a-z0-9][a-z0-9_-]*)=(\d+)$/.exec(tuple);
    if (!m) throw new Error(`invalid scale entry "${tuple}", expected e.g. web=2`);
    formation[m[1]!] = Number(m[2]);
  }
  return formation;
}

// One command per line, either a JSON array ["ps:scale", "web=2"] (app is
// taken from app_name) or a full request object {"command": ..., "app": ...}.
export function parseCliCommands(text: string, app: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`cli_commands line is not valid JSON: ${line}`);
    }
    if (Array.isArray(parsed)) {
      const [command, ...args] = parsed;
      if (typeof command !== "string") throw new Error(`cli_commands entry needs a command first: ${line}`);
      out.push({ command, ...(app ? { app } : {}), args: args.map(String) });
    } else if (parsed && typeof parsed === "object") {
      out.push({ ...(app ? { app } : {}), ...(parsed as Record<string, unknown>) });
    } else {
      throw new Error(`cli_commands entry must be an array or object: ${line}`);
    }
  }
  return out;
}

export async function run(): Promise<void> {
  const url = input("dokku_url").replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const token = input("api_token");
  const app = input("app_name");
  if (!url) throw new Error('input "dokku_url" is required');
  if (!token) throw new Error('input "api_token" is required');
  console.log(`::add-mask::${token}`);

  const timeoutSeconds = Number(input("timeout_seconds", "900"));
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('input "timeout_seconds" must be a positive number');
  const client = new Client(url, token, timeoutSeconds * 1000);
  const appPath = `/apps/${encodeURIComponent(app)}`;
  const needApp = (what: string) => {
    if (!app) throw new Error(`input "app_name" is required for ${what}`);
  };

  const config = input("config");
  const image = input("deploy_image");
  const repository = input("deploy_repository");
  const rebuild = boolInput("rebuild", false);
  const scale = input("scale");
  const restart = boolInput("restart", false);
  const cliCommands = input("cli_commands");
  const deploying = Boolean(image || repository || rebuild);
  const results: unknown[] = [];

  if (config) {
    needApp("config");
    const vars = parseConfig(config);
    // A following deploy restarts the app anyway; avoid a double restart.
    const restartAfterConfig = boolInput("config_restart", true) && !deploying;
    group(`Set config: ${Object.keys(vars).join(", ")}`);
    const res = await client.request("PATCH", `${appPath}/config?restart=${restartAfterConfig}`, vars);
    printExecution(res.execution as Execution);
    results.push({ step: "config", keys: res.keys });
    endGroup();
  }

  if (deploying) {
    needApp("deploy");
    const body = image ? { image } : repository ? { repository, ...(input("deploy_ref") ? { ref: input("deploy_ref") } : {}) } : {};
    group(image ? `Deploy image ${image}` : repository ? `Deploy ${repository}` : "Rebuild app");
    const res = await client.request("POST", `${appPath}/deploys`, body);
    printExecution(res as Execution);
    results.push({ step: "deploy", ...res });
    endGroup();
  }

  if (scale) {
    needApp("scale");
    const formation = parseScale(scale);
    group(`Scale ${Object.entries(formation).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    const res = await client.request("PATCH", `${appPath}/formation`, formation);
    printExecution(res.execution as Execution);
    results.push({ step: "scale", formation: res.formation });
    endGroup();
  }

  if (restart) {
    needApp("restart");
    group("Restart app");
    const res = await client.request("POST", `${appPath}/restart`);
    printExecution(res as Execution);
    results.push({ step: "restart", ...res });
    endGroup();
  }

  let last: Execution | undefined;
  for (const request of parseCliCommands(cliCommands, app)) {
    group(`dokku ${String(request.command)}`);
    try {
      last = (await client.request("POST", "/cli", request)) as Execution;
      printExecution(last);
      results.push({ step: "cli", ...last });
    } catch (err) {
      if (err instanceof ApiError) printExecution(err.body as Execution);
      throw err;
    } finally {
      endGroup();
    }
  }

  // Nothing to change: report the app status (or the token's identity without an app).
  if (results.length === 0) {
    const res = await client.request("GET", app ? `${appPath}/status` : "/me");
    console.log(JSON.stringify(res, null, 2));
    setOutput("status", JSON.stringify(res));
    results.push({ step: "status", ...res });
  }

  setOutput("results", JSON.stringify(results));
  setOutput("stdout", last?.stdout ?? "");
}
