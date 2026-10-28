// GitHub Action: talks to the dokku-api daemon. Dependency-free on purpose;
// inputs come from INPUT_* env vars and outputs go to $GITHUB_OUTPUT.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
function input(name, fallback = "") {
    return (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim() || fallback;
}
function boolInput(name, fallback) {
    const value = input(name).toLowerCase();
    if (value === "")
        return fallback;
    if (["true", "yes", "1", "on"].includes(value))
        return true;
    if (["false", "no", "0", "off"].includes(value))
        return false;
    throw new Error(`input "${name}" must be true or false`);
}
function setOutput(name, value) {
    const file = process.env.GITHUB_OUTPUT;
    if (!file)
        return;
    const delimiter = `ghadelim_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
const group = (title) => console.log(`::group::${title}`);
const endGroup = () => console.log("::endgroup::");
export const escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export class ApiError extends Error {
    body;
    status;
    constructor(message, body, status) {
        super(message);
        this.body = body;
        this.status = status;
    }
}
// Worth another attempt: the dokku command failed (422), the server or proxy
// had a problem (5xx), or the connection broke. Not retried: input and
// permission errors, and our own timeout, because the build may still be
// running on the server.
export function isRetryable(err) {
    if (err instanceof ApiError)
        return err.status === 422 || err.status >= 500;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
        return false;
    const code = err?.code;
    return typeof code === "string" && NETWORK_ERRORS.has(code);
}
const NETWORK_ERRORS = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);
// One HTTP request with a single deadline for the whole exchange. Not fetch:
// undici gives up after 300 s without response headers, whatever the signal
// says, and a synchronous deploy sends its headers only when the build is done.
export function httpExchange(url, options) {
    return new Promise((resolve, reject) => {
        const send = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : undefined;
        if (!send)
            return reject(new Error(`unsupported URL ${url.href}`));
        const req = send(url, { method: options.method, headers: options.headers }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                clearTimeout(timer);
                resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
            });
            res.on("error", fail);
        });
        function fail(err) {
            clearTimeout(timer);
            reject(err);
        }
        const timer = setTimeout(() => {
            const err = new Error(`no complete response within ${Math.round(options.timeoutMs / 1000)} s`);
            err.name = "TimeoutError";
            req.destroy(err);
        }, options.timeoutMs);
        req.on("error", fail);
        // A build can keep the connection silent for many minutes.
        req.on("socket", (socket) => socket.setKeepAlive(true, 30_000));
        req.end(options.body);
    });
}
export async function withRetries(attempt, retries, delayMs, onRetry = () => { }, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    for (let left = retries;; left--) {
        try {
            return await attempt();
        }
        catch (err) {
            if (left <= 0 || !isRetryable(err))
                throw err;
            onRetry(err, left);
            await sleep(delayMs);
        }
    }
}
function intInput(name, fallback) {
    const raw = input(name);
    if (raw === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0)
        throw new Error(`input "${name}" must be a whole number of 0 or more`);
    return value;
}
// Requests a GitHub Actions OIDC token for `audience`. GitHub only offers
// this to jobs with `permissions: id-token: write`.
export async function requestIdToken(audience, env = process.env) {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) {
        throw new Error('no api_token given and no GitHub OIDC token available: add "permissions: id-token: write" to the job');
    }
    const target = new URL(url);
    target.searchParams.set("audience", audience);
    const res = await fetch(target, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
        throw new Error(`requesting a GitHub OIDC token failed with HTTP ${res.status}`);
    const body = (await res.json());
    if (typeof body.value !== "string" || !body.value)
        throw new Error("GitHub returned no OIDC token");
    return body.value;
}
export class Client {
    baseUrl;
    token;
    timeoutMs;
    constructor(baseUrl, 
    // Called per request: OIDC tokens expire within minutes, and a deploy can take longer.
    token, timeoutMs) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.timeoutMs = timeoutMs;
    }
    async request(method, path, body) {
        const res = await httpExchange(new URL(`${this.baseUrl}/api/v1${path}`), {
            method,
            headers: {
                Authorization: `Bearer ${await this.token()}`,
                Accept: "application/json",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                "User-Agent": "dokku-api-action",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            timeoutMs: this.timeoutMs,
        });
        const text = res.text;
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : {};
        }
        catch {
            parsed = { raw: text };
        }
        if (res.status < 200 || res.status >= 300) {
            const detail = [parsed.title, parsed.detail].filter(Boolean).join(": ") || text.slice(0, 500);
            throw new ApiError(`${method} ${path} failed with HTTP ${res.status}: ${detail}`, parsed, res.status);
        }
        return parsed;
    }
}
// Polls `url` until it answers 2xx (and its body contains `contains`, if
// given) or `timeoutMs` passes. Returns the number of attempts.
export async function waitForHealthy(url, options, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    const target = new URL(url);
    const deadline = Date.now() + options.timeoutMs;
    const log = options.log ?? (() => { });
    for (let attempt = 1;; attempt++) {
        let problem;
        try {
            const res = await httpExchange(target, {
                method: "GET",
                headers: { Accept: "*/*", "User-Agent": "dokku-api-action" },
                timeoutMs: Math.max(1000, Math.min(10_000, deadline - Date.now())),
            });
            const healthy = res.status >= 200 && res.status < 300;
            if (healthy && (!options.contains || res.text.includes(options.contains)))
                return attempt;
            problem = healthy ? `response does not contain "${options.contains}"` : `HTTP ${res.status}`;
        }
        catch (err) {
            problem = err instanceof Error ? err.message : String(err);
        }
        if (Date.now() >= deadline) {
            throw new Error(`health check of ${url} failed after ${attempt} attempt(s): ${problem}`);
        }
        log(`attempt ${attempt}: ${problem}`);
        await sleep(options.intervalMs ?? 5000);
    }
}
export function printExecution(e) {
    if (!e)
        return;
    if (e.command_executed)
        console.log(`$ ${e.command_executed}`);
    if (e.stdout)
        console.log(e.stdout.trimEnd());
    if (e.stderr)
        console.log(e.stderr.trimEnd());
    if (e.duration_ms !== undefined)
        console.log(`(exit ${e.exit_code}, ${e.duration_ms} ms)`);
}
// "KEY=value" per line; blank lines and lines starting with # are ignored.
export function parseConfig(text) {
    const vars = {};
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const eq = line.indexOf("=");
        if (eq <= 0)
            throw new Error(`invalid config line "${line}", expected KEY=value`);
        let value = line.slice(eq + 1);
        if (/^(['"]).*\1$/.test(value) && value.length >= 2)
            value = value.slice(1, -1);
        vars[line.slice(0, eq).trim()] = value;
    }
    return vars;
}
// "web=2 worker=1" or one tuple per line.
export function parseScale(text) {
    const formation = {};
    for (const tuple of text.split(/[\s,]+/).filter(Boolean)) {
        const m = /^([a-z0-9][a-z0-9_-]*)=(\d+)$/.exec(tuple);
        if (!m)
            throw new Error(`invalid scale entry "${tuple}", expected e.g. web=2`);
        formation[m[1]] = Number(m[2]);
    }
    return formation;
}
// One command per line, either a JSON array ["ps:scale", "web=2"] (app is
// taken from app_name) or a full request object {"command": ..., "app": ...}.
export function parseCliCommands(text, app) {
    const out = [];
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            throw new Error(`cli_commands line is not valid JSON: ${line}`);
        }
        if (Array.isArray(parsed)) {
            const [command, ...args] = parsed;
            if (typeof command !== "string")
                throw new Error(`cli_commands entry needs a command first: ${line}`);
            out.push({ command, ...(app ? { app } : {}), args: args.map(String) });
        }
        else if (parsed && typeof parsed === "object") {
            out.push({ ...(app ? { app } : {}), ...parsed });
        }
        else {
            throw new Error(`cli_commands entry must be an array or object: ${line}`);
        }
    }
    return out;
}
export async function run() {
    const url = input("dokku_url").replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    const apiToken = input("api_token");
    const app = input("app_name");
    if (!url)
        throw new Error('input "dokku_url" is required');
    let token;
    if (apiToken) {
        console.log(`::add-mask::${apiToken}`);
        token = async () => apiToken;
    }
    else {
        // No secret: authenticate as this workflow run via GitHub OIDC.
        const audience = input("audience") || new URL(url).origin;
        token = async () => {
            const jwt = await requestIdToken(audience);
            console.log(`::add-mask::${jwt}`);
            return jwt;
        };
    }
    const timeoutSeconds = Number(input("timeout_seconds", "900"));
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
        throw new Error('input "timeout_seconds" must be a positive number');
    const client = new Client(url, token, timeoutSeconds * 1000);
    const appPath = `/apps/${encodeURIComponent(app)}`;
    const needApp = (what) => {
        if (!app)
            throw new Error(`input "app_name" is required for ${what}`);
    };
    const config = input("config");
    const image = input("deploy_image");
    const repository = input("deploy_repository");
    const rebuild = boolInput("rebuild", false);
    const scale = input("scale");
    const restart = boolInput("restart", false);
    const cliCommands = input("cli_commands");
    const deploying = Boolean(image || repository || rebuild);
    const results = [];
    if (config) {
        needApp("config");
        const vars = parseConfig(config);
        // A following deploy restarts the app anyway; avoid a double restart.
        const restartAfterConfig = boolInput("config_restart", true) && !deploying;
        group(`Set config: ${Object.keys(vars).join(", ")}`);
        const res = await client.request("PATCH", `${appPath}/config?restart=${restartAfterConfig}`, vars);
        printExecution((res.execution ?? res));
        results.push({ step: "config", keys: res.keys });
        endGroup();
    }
    if (deploying) {
        needApp("deploy");
        const body = image ? { image } : repository ? { repository, ...(input("deploy_ref") ? { ref: input("deploy_ref") } : {}) } : {};
        const retries = intInput("deploy_retries", 0);
        const delaySeconds = intInput("deploy_retry_delay", 60);
        group(image ? `Deploy image ${image}` : repository ? `Deploy ${repository}` : "Rebuild app");
        const res = await withRetries(() => client.request("POST", `${appPath}/deploys`, body), retries, delaySeconds * 1000, (err, left) => {
            if (err instanceof ApiError)
                printExecution(err.body);
            const message = err instanceof Error ? err.message : String(err);
            console.log(`::warning::${escapeData(`Deploy failed (${message}); retrying in ${delaySeconds} s, ${left} attempt(s) left.`)}`);
        });
        printExecution(res);
        results.push({ step: "deploy", ...res });
        endGroup();
    }
    if (scale) {
        needApp("scale");
        const formation = parseScale(scale);
        group(`Scale ${Object.entries(formation).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        const res = await client.request("PATCH", `${appPath}/formation`, formation);
        printExecution((res.execution ?? res));
        results.push({ step: "scale", formation: res.formation });
        endGroup();
    }
    if (restart) {
        needApp("restart");
        group("Restart app");
        const res = await client.request("POST", `${appPath}/restart`);
        printExecution(res);
        results.push({ step: "restart", ...res });
        endGroup();
    }
    let last;
    for (const request of parseCliCommands(cliCommands, app)) {
        group(`dokku ${String(request.command)}`);
        try {
            last = (await client.request("POST", "/cli", request));
            printExecution(last);
            results.push({ step: "cli", ...last });
        }
        catch (err) {
            if (err instanceof ApiError)
                printExecution(err.body);
            throw err;
        }
        finally {
            endGroup();
        }
    }
    // Optional: wait until the app answers on its own URL. Not every app has a
    // health endpoint, so nothing happens without health_check_url.
    const healthUrl = input("health_check_url");
    if (healthUrl) {
        const contains = input("health_check_contains");
        const timeoutSeconds = intInput("health_check_timeout", 120);
        group(`Health check ${healthUrl}${contains ? ` (expecting "${contains}")` : ""}`);
        try {
            const attempts = await waitForHealthy(healthUrl, { contains, timeoutMs: timeoutSeconds * 1000, log: (l) => console.log(l) });
            console.log(`healthy after ${attempts} attempt(s)`);
            results.push({ step: "health_check", url: healthUrl, attempts });
        }
        finally {
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
