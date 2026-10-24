// Scope model: a token holds (app_pattern, scope) pairs. Every endpoint and
// every allow-listed CLI command requires exactly one scope on the target app.
export const SCOPES = {
    read: "List apps, read app reports, status and process formation",
    logs: "Read recent application logs",
    "config:read": "Read environment variables",
    "config:write": "Set environment variables",
    scale: "Change the process formation (ps:scale)",
    restart: "Restart, start and stop apps",
    deploy: "Deploy an image, sync a git repository or rebuild an app",
    cli: "Run custom allow-listed commands through the CLI bridge",
};
// Shorthands accepted by `api:perm-add` and `api:token-create`. They are
// expanded before being stored, so the database always holds concrete scopes.
export const SCOPE_ALIASES = {
    readonly: ["read", "logs"],
    readwrite: ["read", "logs", "config:read", "config:write", "scale", "restart", "deploy"],
    all: Object.keys(SCOPES),
};
export function isScope(value) {
    return Object.hasOwn(SCOPES, value);
}
export function expandScopes(input) {
    const result = new Set();
    for (const raw of input.split(",")) {
        const name = raw.trim();
        if (!name)
            continue;
        const alias = SCOPE_ALIASES[name] ?? (name === "*" ? SCOPE_ALIASES.all : undefined);
        if (alias) {
            alias.forEach((s) => result.add(s));
        }
        else if (isScope(name)) {
            result.add(name);
        }
        else {
            throw new Error(`unknown scope "${name}" (valid: ${[...Object.keys(SCOPES), ...Object.keys(SCOPE_ALIASES)].join(", ")})`);
        }
    }
    if (result.size === 0)
        throw new Error("no scope given");
    return [...result];
}
// Glob matching for app patterns and command prefixes: "*" matches any run of
// characters, everything else is literal. "shop-*" matches "shop-api".
export function globMatch(pattern, value) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(value);
}
export const APP_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export const APP_PATTERN_RE = /^[a-z0-9*][a-z0-9.*-]{0,63}$/;
