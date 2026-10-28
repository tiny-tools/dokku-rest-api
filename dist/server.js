import { createServer } from "node:http";
import { authorizeCli } from "./allowlist.js";
import { Store } from "./db.js";
import { runDokku } from "./dokku.js";
import { HttpError, isPlainObject, parseBool, readJsonBody, sendJson, sendProblem } from "./http.js";
import { authenticateGithub, AuthError, looksLikeJwt } from "./oidc.js";
import { APP_NAME_RE, globMatch } from "./scopes.js";
export const VERSION = "1.2.0";
const PROCESS_RE = /^[a-z0-9][a-z0-9_-]*$/;
const CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const IMAGE_RE = /^[^\s-][^\s]*$/;
const REPO_RE = /^(https:\/\/|git@)\S+$/;
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
// --- helpers ---------------------------------------------------------------
async function exec(ctx, argv, opts = {}) {
    ctx.audit.command = argv[0] ?? null;
    const result = await runDokku(argv, opts);
    ctx.audit.exit_code = result.exit_code;
    return result;
}
function lastLines(text, n) {
    const trailing = text.endsWith("\n");
    const lines = (trailing ? text.slice(0, -1) : text).split("\n");
    if (text === "" || lines.length <= n)
        return { text, cut: false };
    return { text: lines.slice(lines.length - n).join("\n") + (trailing && n > 0 ? "\n" : ""), cut: true };
}
// A command result as returned to the client: the same fields everywhere,
// with stdout/stderr shortened when the request asked for `?log_tail=N`.
function present(ctx, result) {
    if (ctx.logTail === undefined)
        return result;
    const stdout = lastLines(result.stdout, ctx.logTail);
    const stderr = lastLines(result.stderr, ctx.logTail);
    return { ...result, stdout: stdout.text, stderr: stderr.text, truncated: stdout.cut || stderr.cut };
}
// Maps a failed dokku invocation to an HTTP error.
function failure(ctx, result) {
    const output = `${result.stderr}\n${result.stdout}`;
    const shown = present(ctx, result);
    if (result.timed_out)
        return new HttpError(504, "Command timed out", "the dokku command did not finish in time", shown);
    if (/does not exist/i.test(output))
        return new HttpError(404, "Not Found", output.trim().split("\n").pop()?.replace(/^[\s!>-]+/, ""));
    return new HttpError(422, "Command failed", `dokku exited with code ${result.exit_code}`, shown);
}
async function execOrThrow(ctx, argv, opts) {
    const result = await exec(ctx, argv, opts);
    if (!result.ok)
        throw failure(ctx, result);
    return result;
}
function parseJsonOutput(stdout) {
    const trimmed = stdout.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // Older Dokku versions print a header before the JSON; take the last JSON-looking line.
        const line = trimmed.split("\n").reverse().find((l) => /^[[{]/.test(l.trim()));
        if (line) {
            try {
                return JSON.parse(line);
            }
            catch {
                /* fall through */
            }
        }
        return { raw: stdout };
    }
}
async function body(ctx) {
    const parsed = await readJsonBody(ctx.req);
    if (parsed === undefined)
        return {};
    if (!isPlainObject(parsed))
        throw new HttpError(400, "Invalid body", "expected a JSON object");
    return parsed;
}
function app(ctx) {
    const name = ctx.params.app;
    ctx.audit.app = name;
    return name;
}
function reportValue(report, ...keys) {
    if (!isPlainObject(report))
        return undefined;
    for (const key of keys)
        if (key in report)
            return report[key];
    return undefined;
}
function asBool(value) {
    if (typeof value === "boolean")
        return value;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return undefined;
}
async function formation(ctx, name) {
    const result = await execOrThrow(ctx, ["ps:scale", "--format", "json", name]);
    const parsed = parseJsonOutput(result.stdout);
    const out = {};
    if (Array.isArray(parsed)) {
        for (const entry of parsed) {
            if (isPlainObject(entry) && typeof entry.process_type === "string")
                out[entry.process_type] = Number(entry.quantity);
        }
    }
    else {
        // Text fallback: "web:  1" lines.
        for (const m of result.stdout.matchAll(/^\s*([a-z0-9][a-z0-9_-]*):\s+(\d+)\s*$/gm))
            out[m[1]] = Number(m[2]);
    }
    return out;
}
async function runCli(ctx, request) {
    const decision = authorizeCli(ctx.store, ctx.token.id, request);
    ctx.audit.command = typeof request.command === "string" ? request.command : null;
    ctx.audit.app = typeof request.app === "string" ? request.app : null;
    if (!decision.ok)
        throw new HttpError(decision.status, decision.title, decision.detail);
    const result = await exec(ctx, decision.argv);
    if (result.timed_out)
        throw failure(ctx, result);
    return { status: result.ok ? 200 : 422, body: present(ctx, result) };
}
// --- routes ----------------------------------------------------------------
const routes = [
    {
        method: "GET",
        pattern: /^\/api\/v1\/me$/,
        handler: async (ctx) => {
            const trust = ctx.token.kind === "github" ? ctx.store.getGithubTrust(ctx.token.id) : undefined;
            return {
                name: ctx.token.name,
                kind: ctx.token.kind,
                ...(trust
                    ? {
                        github: {
                            repository: trust.repository,
                            environment: trust.environment,
                            ref: trust.ref_pattern,
                            workflow: trust.workflow,
                        },
                    }
                    : { token_prefix: ctx.token.token_prefix }),
                created_at: ctx.token.created_at,
                expires_at: ctx.token.expires_at,
                permissions: ctx.store.listPermissions(ctx.token.id).map((p) => ({ app_pattern: p.app_pattern, scope: p.scope })),
            };
        },
    },
    {
        method: "GET",
        pattern: /^\/api\/v1\/allowlist$/,
        handler: async (ctx) => {
            const perms = ctx.store.listPermissions(ctx.token.id);
            return {
                commands: ctx.store
                    .allowlistFor(ctx.token.id)
                    .filter((e) => perms.some((p) => p.scope === e.scope && (e.require_app_match === 1 || p.app_pattern === "*")))
                    .map((e) => ({
                    command: e.command_prefix,
                    scope: e.scope,
                    require_app: e.require_app_match === 1,
                    allowed_args_regex: e.allowed_flags_regex,
                    description: e.description,
                })),
            };
        },
    },
    {
        method: "GET",
        pattern: /^\/api\/v1\/apps$/,
        handler: async (ctx) => {
            const perms = ctx.store.listPermissions(ctx.token.id).filter((p) => p.scope === "read");
            if (perms.length === 0)
                throw new HttpError(403, "Forbidden", 'token has no "read" scope');
            const result = await execOrThrow(ctx, ["apps:list", "--format", "json"]);
            let names = parseJsonOutput(result.stdout);
            if (!Array.isArray(names)) {
                names = result.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("=") && !l.startsWith("-"));
            }
            const visible = names
                .filter((n) => typeof n === "string")
                .filter((n) => perms.some((p) => globMatch(p.app_pattern, n)));
            return { apps: visible.map((name) => ({ name })) };
        },
    },
    {
        method: "GET",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)$/,
        scope: "read",
        handler: async (ctx) => {
            const name = app(ctx);
            const result = await execOrThrow(ctx, ["apps:report", "--format", "json", name]);
            return { name, report: parseJsonOutput(result.stdout) };
        },
    },
    {
        method: "GET",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/status$/,
        scope: "read",
        handler: async (ctx) => {
            const name = app(ctx);
            const [report, scale] = await Promise.all([
                execOrThrow(ctx, ["ps:report", "--format", "json", name]).then((r) => parseJsonOutput(r.stdout)),
                formation(ctx, name),
            ]);
            return {
                name,
                deployed: asBool(reportValue(report, "deployed", "ps-deployed")),
                running: asBool(reportValue(report, "running", "ps-running")),
                processes: Number(reportValue(report, "processes", "ps-processes") ?? NaN) || 0,
                formation: scale,
                report,
            };
        },
    },
    {
        method: "GET",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/formation$/,
        scope: "read",
        handler: async (ctx) => {
            const name = app(ctx);
            return { name, formation: await formation(ctx, name) };
        },
    },
    {
        method: "PATCH",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/formation$/,
        scope: "scale",
        handler: async (ctx) => {
            const name = app(ctx);
            const input = await body(ctx);
            const tuples = Object.entries(input).map(([proc, qty]) => {
                if (!PROCESS_RE.test(proc))
                    throw new HttpError(400, "Invalid process type", `"${proc}" is not a valid process type`);
                if (!Number.isInteger(qty) || qty < 0 || qty > 999) {
                    throw new HttpError(400, "Invalid quantity", `"${proc}" must be an integer between 0 and 999`);
                }
                return `${proc}=${qty}`;
            });
            if (tuples.length === 0)
                throw new HttpError(400, "Invalid body", 'expected e.g. {"web": 2, "worker": 1}');
            const skipDeploy = parseBool(ctx.url.searchParams.get("skip_deploy"), false);
            const result = present(ctx, await execOrThrow(ctx, ["ps:scale", ...(skipDeploy ? ["--skip-deploy"] : []), name, ...tuples]));
            // `execution` duplicates the top-level fields for clients of 1.0; it goes away in 2.0.
            return { name, formation: await formation(ctx, name), ...result, execution: result };
        },
    },
    {
        method: "GET",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/config$/,
        scope: "config:read",
        handler: async (ctx) => {
            const name = app(ctx);
            const result = await execOrThrow(ctx, ["config:export", "--format", "json", name]);
            return { name, config: parseJsonOutput(result.stdout) };
        },
    },
    {
        method: "GET",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/config\/(?<key>[^/]+)$/,
        scope: "config:read",
        handler: async (ctx) => {
            const name = app(ctx);
            const key = ctx.params.key;
            if (!CONFIG_KEY_RE.test(key))
                throw new HttpError(400, "Invalid key", `"${key}" is not a valid variable name`);
            const result = await exec(ctx, ["config:get", name, key]);
            if (!result.ok) {
                if (/does not exist/i.test(result.stderr + result.stdout))
                    throw failure(ctx, result);
                throw new HttpError(404, "Not Found", `config var "${key}" is not set`);
            }
            return { key, value: result.stdout.replace(/\n$/, "") };
        },
    },
    {
        method: "PATCH",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/config$/,
        scope: "config:write",
        handler: async (ctx) => setConfig(ctx, await body(ctx)),
    },
    {
        method: "PUT",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/config\/(?<key>[^/]+)$/,
        scope: "config:write",
        handler: async (ctx) => {
            const input = await body(ctx);
            if (!("value" in input))
                throw new HttpError(400, "Invalid body", 'expected {"value": "..."}');
            return setConfig(ctx, { [ctx.params.key]: input.value });
        },
    },
    {
        method: "GET",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/logs$/,
        scope: "logs",
        handler: async (ctx) => {
            const name = app(ctx);
            const lines = Number(ctx.url.searchParams.get("lines") ?? 100);
            if (!Number.isInteger(lines) || lines < 1 || lines > 10000) {
                throw new HttpError(400, "Invalid query parameter", '"lines" must be an integer between 1 and 10000');
            }
            const proc = ctx.url.searchParams.get("process");
            if (proc !== null && !PROCESS_RE.test(proc))
                throw new HttpError(400, "Invalid query parameter", '"process" is invalid');
            const result = await execOrThrow(ctx, ["logs", "--num", String(lines), ...(proc ? ["--ps", proc] : []), name], {
                timeoutMs: 60_000,
            });
            return { name, lines: result.stdout.split("\n").filter((l, i, a) => l !== "" || i < a.length - 1) };
        },
    },
    ...["restart", "start", "stop"].map((action) => ({
        method: "POST",
        pattern: new RegExp(`^/api/v1/apps/(?<app>[^/]+)/${action}$`),
        scope: "restart",
        handler: async (ctx) => {
            const name = app(ctx);
            const input = await body(ctx);
            const proc = input.process;
            if (proc !== undefined && (action !== "restart" || typeof proc !== "string" || !PROCESS_RE.test(proc))) {
                throw new HttpError(400, "Invalid body", '"process" is only supported for restart and must be a process type');
            }
            return present(ctx, await execOrThrow(ctx, [`ps:${action}`, name, ...(proc ? [proc] : [])]));
        },
    })),
    {
        method: "POST",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/deploys$/,
        scope: "deploy",
        handler: async (ctx) => {
            const name = app(ctx);
            const input = await body(ctx);
            let argv;
            if (input.image !== undefined) {
                if (typeof input.image !== "string" || !IMAGE_RE.test(input.image))
                    throw new HttpError(400, "Invalid image", '"image" is invalid');
                argv = ["git:from-image", ...(input.force === true ? ["--force"] : []), name, input.image];
            }
            else if (input.repository !== undefined) {
                if (typeof input.repository !== "string" || !REPO_RE.test(input.repository)) {
                    throw new HttpError(400, "Invalid repository", '"repository" must start with https:// or git@');
                }
                if (input.ref !== undefined && (typeof input.ref !== "string" || !REF_RE.test(input.ref))) {
                    throw new HttpError(400, "Invalid ref", '"ref" is invalid');
                }
                argv = ["git:sync", "--build", name, input.repository, ...(input.ref ? [input.ref] : [])];
            }
            else {
                argv = ["ps:rebuild", name];
            }
            return present(ctx, await execOrThrow(ctx, argv));
        },
    },
    {
        method: "POST",
        pattern: /^\/api\/v1\/cli$/,
        handler: async (ctx) => {
            const { status, body: result } = await runCli(ctx, (await body(ctx)));
            ctx.res.statusCode = status;
            return result;
        },
    },
    {
        method: "POST",
        pattern: /^\/api\/v1\/apps\/(?<app>[^/]+)\/cli\/(?<ns>[a-z0-9-]+)(?:\/(?<sub>[a-z0-9-]+))?$/,
        handler: async (ctx) => {
            const input = await body(ctx);
            const command = ctx.params.sub ? `${ctx.params.ns}:${ctx.params.sub}` : ctx.params.ns;
            const { status, body: result } = await runCli(ctx, { command, app: ctx.params.app, args: input.args, flags: input.flags });
            ctx.res.statusCode = status;
            return result;
        },
    },
];
async function setConfig(ctx, vars) {
    const name = app(ctx);
    const entries = Object.entries(vars);
    if (entries.length === 0)
        throw new HttpError(400, "Invalid body", 'expected e.g. {"KEY": "value"}');
    const pairs = entries.map(([key, value]) => {
        if (!CONFIG_KEY_RE.test(key))
            throw new HttpError(400, "Invalid key", `"${key}" is not a valid variable name`);
        if (value === null)
            throw new HttpError(400, "Unsupported", `unsetting variables is not supported ("${key}")`);
        if (!["string", "number", "boolean"].includes(typeof value)) {
            throw new HttpError(400, "Invalid value", `value of "${key}" must be a string, number or boolean`);
        }
        return `${key}=${Buffer.from(String(value), "utf8").toString("base64")}`;
    });
    const restart = parseBool(ctx.url.searchParams.get("restart"), true);
    const result = present(ctx, await execOrThrow(ctx, ["config:set", "--encoded", ...(restart ? [] : ["--no-restart"]), name, ...pairs], { redact: true }));
    // `execution` duplicates the top-level fields for clients of 1.0; it goes away in 2.0.
    return { name, keys: entries.map(([k]) => k), restarted: restart, ...result, execution: result };
}
// --- server ----------------------------------------------------------------
async function authenticate(store, req) {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const challenge = { "WWW-Authenticate": 'Bearer realm="dokku-api"' };
    if (!match)
        throw new HttpError(401, "Unauthorized", "missing bearer token", {}, challenge);
    const secret = match[1];
    // API tokens never contain dots; a JWT is a GitHub Actions OIDC token.
    if (looksLikeJwt(secret)) {
        const audience = store.getSetting("oidc-audience");
        if (!audience) {
            throw new HttpError(401, "Unauthorized", 'GitHub OIDC is not set up on this server (run "dokku api:setup --domain <domain>")', {}, challenge);
        }
        try {
            return await authenticateGithub(store, secret, audience);
        }
        catch (err) {
            if (err instanceof AuthError)
                throw new HttpError(401, "Unauthorized", err.message, {}, challenge);
            throw err;
        }
    }
    const token = store.findTokenBySecret(secret);
    if (!token || token.revoked)
        throw new HttpError(401, "Unauthorized", "invalid or revoked token", {}, challenge);
    if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) {
        throw new HttpError(401, "Unauthorized", "token expired", {}, challenge);
    }
    return token;
}
function remoteAddr(req) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    return first || req.socket.remoteAddress || null;
}
export function createApiServer(store) {
    return createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.replace(/\/+$/, "") || "/";
        let token = null;
        const audit = { app: null, command: null, exit_code: null };
        try {
            if (path === "/api/v1/health" || path === "/health") {
                if (req.method !== "GET" && req.method !== "HEAD")
                    throw new HttpError(405, "Method Not Allowed", undefined, {}, { Allow: "GET" });
                return sendJson(res, 200, { status: "ok", version: VERSION });
            }
            const candidates = routes
                .map((route) => ({ route, match: route.pattern.exec(path) }))
                .filter((c) => c.match !== null);
            if (candidates.length === 0)
                throw new HttpError(404, "Not Found", `no route for ${path}`);
            const hit = candidates.find((c) => c.route.method === req.method);
            if (!hit) {
                const allow = [...new Set(candidates.map((c) => c.route.method))].join(", ");
                throw new HttpError(405, "Method Not Allowed", `use ${allow}`, {}, { Allow: allow });
            }
            token = await authenticate(store, req);
            store.touchToken(token.id);
            const params = {};
            try {
                for (const [k, v] of Object.entries(hit.match.groups ?? {}))
                    if (v !== undefined)
                        params[k] = decodeURIComponent(v);
            }
            catch {
                throw new HttpError(400, "Bad Request", "malformed URL encoding");
            }
            if (params.app !== undefined && !APP_NAME_RE.test(params.app))
                throw new HttpError(400, "Invalid app", "invalid app name");
            if (hit.route.scope && !store.hasScope(token.id, hit.route.scope, params.app ?? null)) {
                throw new HttpError(403, "Forbidden", `token lacks scope "${hit.route.scope}" for ${params.app ? `app "${params.app}"` : "all apps"}`);
            }
            const tailParam = url.searchParams.get("log_tail");
            const logTail = tailParam === null ? undefined : Number(tailParam);
            if (logTail !== undefined && (!Number.isInteger(logTail) || logTail < 0 || logTail > 100000)) {
                throw new HttpError(400, "Invalid query parameter", '"log_tail" must be an integer between 0 and 100000');
            }
            const ctx = { req, res, url, params, token, store, logTail, audit };
            res.statusCode = 200;
            const result = await hit.route.handler(ctx);
            sendJson(res, res.statusCode, result);
        }
        catch (err) {
            const httpErr = err instanceof HttpError
                ? err
                : (console.error(err), new HttpError(500, "Internal Server Error", "unexpected error, see daemon logs"));
            sendProblem(res, httpErr, path);
        }
        finally {
            if (token) {
                try {
                    store.audit({
                        token_id: token.id,
                        method: req.method ?? "?",
                        path,
                        app: audit.app,
                        command: audit.command,
                        status: res.statusCode,
                        exit_code: audit.exit_code,
                        remote_addr: remoteAddr(req),
                    });
                }
                catch (err) {
                    console.error("audit log write failed", err);
                }
            }
        }
    });
}
export function main() {
    const store = new Store();
    const host = process.env.DOKKU_API_HOST || "127.0.0.1";
    const port = Number(process.env.DOKKU_API_PORT || 5099);
    const server = createApiServer(store);
    // Deploys can take minutes; let the exec timeout decide, not the socket.
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    server.listen(port, host, () => console.log(`dokku-api ${VERSION} listening on http://${host}:${port}`));
    const shutdown = () => server.close(() => (store.close(), process.exit(0)));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
