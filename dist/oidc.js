// GitHub Actions OIDC: a workflow job with `permissions: id-token: write` gets
// a short-lived ID token (a JWT signed by GitHub). We verify it against
// GitHub's published keys and map its claims to a trust created with
// `dokku api:trust-github`. No secret is stored on either side.
import { createPublicKey, verify } from "node:crypto";
import { HttpError, isPlainObject } from "./http.js";
import { globMatch } from "./scopes.js";
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const LEEWAY_S = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;
// Authentication failed; the server answers 401 with this message.
export class AuthError extends Error {
}
// GitHub Enterprise Server and tests use a different issuer.
export function githubIssuer() {
    return (process.env.DOKKU_API_GITHUB_OIDC_ISSUER || GITHUB_ISSUER).replace(/\/+$/, "");
}
export function looksLikeJwt(value) {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}
// --- signing keys ------------------------------------------------------------
let jwks = null;
async function fetchKeys(issuer) {
    const res = await fetch(`${issuer}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    const body = (await res.json());
    const keys = new Map();
    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
        if (!isPlainObject(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string")
            continue;
        try {
            keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
        }
        catch {
            /* skip malformed keys */
        }
    }
    return keys;
}
async function signingKey(kid) {
    const issuer = githubIssuer();
    const now = Date.now();
    const current = jwks?.issuer === issuer ? jwks : null;
    // An unknown kid means GitHub rotated its keys; refetch, at most once a minute.
    const refresh = !current || now - current.fetchedAt > JWKS_TTL_MS || (!current.keys.has(kid) && now - current.fetchedAt > JWKS_MIN_REFRESH_MS);
    if (refresh) {
        try {
            jwks = { issuer, fetchedAt: now, keys: await fetchKeys(issuer) };
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (!current)
                throw new HttpError(503, "Service Unavailable", `cannot fetch GitHub's OIDC signing keys (${reason})`);
            console.error(`refreshing GitHub's OIDC signing keys failed (${reason}); using the cached keys`);
        }
    }
    return jwks?.keys.get(kid);
}
// --- token verification ------------------------------------------------------
function decodePart(part) {
    try {
        const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
        if (isPlainObject(parsed))
            return parsed;
    }
    catch {
        /* fall through */
    }
    throw new AuthError("malformed OIDC token");
}
export async function verifyGithubToken(jwt, audience, now = Date.now()) {
    const [h, p, s] = jwt.split(".");
    const header = decodePart(h);
    if (header.alg !== "RS256" || typeof header.kid !== "string")
        throw new AuthError("unsupported OIDC token algorithm");
    const key = await signingKey(header.kid);
    if (!key)
        throw new AuthError("OIDC token is signed with an unknown key");
    if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) {
        throw new AuthError("invalid OIDC token signature");
    }
    const claims = decodePart(p);
    const seconds = now / 1000;
    if (claims.iss !== githubIssuer())
        throw new AuthError("OIDC token was not issued by GitHub Actions");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience))
        throw new AuthError(`OIDC token audience must be "${audience}"`);
    if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < seconds)
        throw new AuthError("OIDC token expired");
    for (const claim of ["nbf", "iat"]) {
        const value = claims[claim];
        if (value !== undefined && (typeof value !== "number" || value - LEEWAY_S > seconds)) {
            throw new AuthError("OIDC token is not valid yet");
        }
    }
    for (const claim of ["repository", "repository_id", "repository_owner_id"]) {
        if (typeof claims[claim] !== "string" || claims[claim] === "")
            throw new AuthError(`OIDC token has no "${claim}" claim`);
    }
    const optional = (claim) => (typeof claims[claim] === "string" ? claims[claim] : undefined);
    return {
        repository: claims.repository,
        repository_id: claims.repository_id,
        repository_owner_id: claims.repository_owner_id,
        environment: optional("environment"),
        ref: optional("ref"),
        workflow_ref: optional("workflow_ref"),
    };
}
// --- trusts --------------------------------------------------------------------
// "owner/repo/.github/workflows/deploy.yml@refs/heads/main" -> ".github/workflows/deploy.yml"
export function workflowPath(claims) {
    const ref = claims.workflow_ref;
    if (!ref)
        return undefined;
    const at = ref.lastIndexOf("@");
    const path = at === -1 ? ref : ref.slice(0, at);
    const prefix = `${claims.repository}/`;
    return path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : undefined;
}
function conditions(trust) {
    return [trust.environment, trust.ref_pattern, trust.workflow].filter((c) => c !== null).length;
}
function matches(trust, claims, now) {
    if (trust.revoked || (trust.expires_at && Date.parse(trust.expires_at) <= now))
        return false;
    if (trust.repository_id !== null && trust.repository_id !== claims.repository_id)
        return false;
    if (trust.repository_owner_id !== null && trust.repository_owner_id !== claims.repository_owner_id)
        return false;
    if (trust.environment !== null && trust.environment.toLowerCase() !== claims.environment?.toLowerCase())
        return false;
    if (trust.ref_pattern !== null && !(claims.ref && globMatch(trust.ref_pattern, claims.ref)))
        return false;
    if (trust.workflow !== null && trust.workflow !== workflowPath(claims))
        return false;
    return true;
}
// The most specific matching trust wins (environment, ref and workflow each
// count as one condition). Two equally specific matches are refused.
export function selectTrust(trusts, claims, now = Date.now()) {
    const candidates = trusts.filter((t) => matches(t, claims, now)).sort((a, b) => conditions(b) - conditions(a));
    const [best, second] = candidates;
    if (!best) {
        const context = [claims.environment && `environment "${claims.environment}"`, claims.ref && `ref "${claims.ref}"`]
            .filter(Boolean)
            .join(", ");
        throw new AuthError(`no active trust matches repository "${claims.repository}"${context ? ` (${context})` : ""}`);
    }
    if (second && conditions(second) === conditions(best)) {
        throw new AuthError(`trusts "${best.name}" and "${second.name}" both match; make one more specific or revoke one`);
    }
    return best;
}
export async function authenticateGithub(store, jwt, audience) {
    const claims = await verifyGithubToken(jwt, audience);
    const trust = selectTrust(store.listGithubTrusts(claims.repository), claims);
    if (trust.repository_id === null)
        store.pinGithubTrust(trust.token_id, claims.repository_id, claims.repository_owner_id);
    return store.getTokenById(trust.token_id);
}
