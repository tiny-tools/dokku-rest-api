import { APP_NAME_RE, globMatch } from "./scopes.js";
const NO_ARGS = "^$";
const REPORT_FLAGS = "^(--format|--format=(json|stdout)|json|stdout|--[a-z0-9-]+)$";
const PARALLEL = "--parallel|--parallel=[0-9]{1,3}|[0-9]{1,3}";
const GIT_REF = "[A-Za-z0-9_][A-Za-z0-9._/-]*";
// Seeded into cli_allowlist on first start. Admins can add/remove entries with
// `dokku api:allowlist-add` / `api:allowlist-remove`. Each regex is applied to
// every single argument (flags and positionals), not to the joined string.
export const DEFAULT_ALLOWLIST = [
    ...["apps:report", "ps:report", "domains:report", "git:report", "ports:report", "proxy:report", "checks:report", "resource:report", "nginx:report"].map((command) => ({ command, flags: REPORT_FLAGS, requireApp: true, scope: "read", description: "report" })),
    { command: "apps:exists", flags: NO_ARGS, requireApp: true, scope: "read", description: "check whether an app exists" },
    {
        command: "logs",
        flags: "^(-n|--num|-p|--ps|-q|--quiet|--num=[0-9]{1,5}|--ps=[a-z0-9-]+|[0-9]{1,5}|[a-z0-9][a-z0-9-]*)$",
        requireApp: true,
        scope: "logs",
        description: "recent logs (no --tail)",
    },
    { command: "logs:failed", flags: NO_ARGS, requireApp: true, scope: "logs", description: "last failed deploy log" },
    { command: "config:show", flags: NO_ARGS, requireApp: true, scope: "config:read", description: "show env vars" },
    { command: "config:get", flags: "^(--quoted|[A-Za-z_][A-Za-z0-9_.-]*)$", requireApp: true, scope: "config:read", description: "read one env var" },
    { command: "config:keys", flags: "^--merged$", requireApp: true, scope: "config:read", description: "list env var names" },
    { command: "config:export", flags: "^(--format|--format=[a-z-]+|[a-z-]+)$", requireApp: true, scope: "config:read", description: "export env vars" },
    {
        command: "config:set",
        flags: "^(--no-restart|--encoded|[A-Za-z_][A-Za-z0-9_.-]*=.*)$",
        requireApp: true,
        scope: "config:write",
        description: "set env vars (no --global)",
    },
    {
        command: "ps:scale",
        flags: "^(--skip-deploy|--format|--format=(json|stdout)|json|stdout|[a-z0-9][a-z0-9_-]*=[0-9]{1,3})$",
        requireApp: true,
        scope: "scale",
        description: "get/set the process formation",
    },
    { command: "ps:restart", flags: `^(${PARALLEL}|[a-z][a-z0-9_-]*)$`, requireApp: true, scope: "restart", description: "restart app or one process type" },
    { command: "ps:start", flags: `^(${PARALLEL})$`, requireApp: true, scope: "restart", description: "start app" },
    { command: "ps:stop", flags: `^(${PARALLEL})$`, requireApp: true, scope: "restart", description: "stop app" },
    { command: "ps:rebuild", flags: `^(${PARALLEL})$`, requireApp: true, scope: "deploy", description: "rebuild and redeploy app" },
    {
        command: "git:from-image",
        flags: "^(--force|--build-dir=[^\\s]+|[^\\s-][^\\s]*)$",
        requireApp: true,
        scope: "deploy",
        description: "deploy a docker image",
    },
    {
        command: "git:sync",
        flags: `^(--build|--build-if-changes|https://\\S+|git@\\S+|${GIT_REF})$`,
        requireApp: true,
        scope: "deploy",
        description: "sync from a remote git repository and optionally build",
    },
];
// Global flags Dokku's top-level parser honours anywhere in argv. `--app`
// would let a caller retarget the command to an app outside its scope.
const DENIED_ARGS = [/^--app(=.*)?$/, /^--global$/, /^--all$/, /^--trace$/];
const COMMAND_RE = /^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;
const MAX_ARGS = 100;
const MAX_ARG_LENGTH = 64 * 1024;
function deny(status, title, detail) {
    return { ok: false, status, title, detail };
}
function stringArray(value, field) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        return `"${field}" must be an array of strings`;
    if (value.length > MAX_ARGS)
        return `"${field}" has more than ${MAX_ARGS} entries`;
    const out = [];
    for (const v of value) {
        if (typeof v === "number" || typeof v === "boolean") {
            out.push(String(v));
        }
        else if (typeof v === "string") {
            if (v.length > MAX_ARG_LENGTH || v.includes("\0"))
                return `"${field}" contains an invalid entry`;
            out.push(v);
        }
        else {
            return `"${field}" must be an array of strings`;
        }
    }
    return out;
}
function compile(regex) {
    try {
        return new RegExp(regex, "s");
    }
    catch {
        return null;
    }
}
// Decides whether `tokenId` may run the requested command and builds the
// argv passed to the dokku binary: [command, ...flags, app, ...args].
// Without an explicit `flags` array, leading args starting with "-" are
// treated as flags so they end up in front of the app name.
export function authorizeCli(store, tokenId, req) {
    if (typeof req.command !== "string" || !COMMAND_RE.test(req.command)) {
        return deny(400, "Invalid command", 'expected "command" like "ps:scale" or "logs"');
    }
    const command = req.command;
    let app = null;
    if (req.app !== undefined && req.app !== null && req.app !== "") {
        if (typeof req.app !== "string" || !APP_NAME_RE.test(req.app))
            return deny(400, "Invalid app", "invalid app name");
        app = req.app;
    }
    const args = stringArray(req.args, "args");
    if (typeof args === "string")
        return deny(400, "Invalid arguments", args);
    let flags;
    if (req.flags === undefined) {
        const firstPositional = args.findIndex((a) => !a.startsWith("-"));
        flags = args.splice(0, firstPositional === -1 ? args.length : firstPositional);
    }
    else {
        const parsed = stringArray(req.flags, "flags");
        if (typeof parsed === "string")
            return deny(400, "Invalid arguments", parsed);
        flags = parsed;
    }
    const all = [...flags, ...args];
    const blocked = all.find((a) => DENIED_ARGS.some((re) => re.test(a)));
    if (blocked !== undefined)
        return deny(403, "Argument not permitted", `"${blocked}" is never allowed through the API`);
    const candidates = store.allowlistFor(tokenId).filter((e) => globMatch(e.command_prefix, command));
    if (candidates.length === 0) {
        return deny(403, "Command not allowed", `"${command}" is not on the allow-list`);
    }
    let failure = deny(403, "Command not allowed", `"${command}" is not permitted`);
    for (const entry of candidates) {
        const needsApp = entry.require_app_match === 1;
        if (needsApp && app === null) {
            failure = deny(400, "App required", `"${command}" requires "app"`);
            continue;
        }
        if (!needsApp && app !== null) {
            failure = deny(400, "Unexpected app", `"${command}" is not app-bound; pass the target in "args"`);
            continue;
        }
        if (!store.hasScope(tokenId, entry.scope, needsApp ? app : null)) {
            failure = deny(403, "Missing scope", `token lacks scope "${entry.scope}" for ${needsApp ? `app "${app}"` : "all apps (*)"}`);
            continue;
        }
        const re = compile(entry.allowed_flags_regex);
        if (!re) {
            failure = deny(403, "Command not allowed", `allow-list entry #${entry.id} has an invalid regex`);
            continue;
        }
        const badArg = all.find((a) => !re.test(a));
        if (badArg !== undefined) {
            failure = deny(403, "Argument not permitted", `argument "${badArg}" is not permitted for "${command}"`);
            continue;
        }
        return { ok: true, argv: [command, ...flags, ...(app ? [app] : []), ...args], app, entry };
    }
    return failure;
}
