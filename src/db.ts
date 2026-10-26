import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_ALLOWLIST } from "./allowlist.js";
import { globMatch, type Scope } from "./scopes.js";

export const DEFAULT_DB_PATH = "/var/lib/dokku/data/api/storage.db";

export interface TokenRow {
  id: number;
  // "token": a bearer secret; "github": a trust in GitHub Actions OIDC (no secret).
  kind: "token" | "github";
  name: string;
  token_prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked: number;
}

export interface GithubTrustRow {
  token_id: number;
  repository: string;
  // Pinned on first use, so that a deleted repository's reused name is not trusted.
  repository_id: string | null;
  repository_owner_id: string | null;
  environment: string | null;
  ref_pattern: string | null;
  workflow: string | null;
}

export type GithubTrust = TokenRow & GithubTrustRow;

export interface PermissionRow {
  id: number;
  token_id: number;
  app_pattern: string;
  scope: Scope;
}

export interface AllowlistRow {
  id: number;
  token_id: number | null;
  command_prefix: string;
  allowed_flags_regex: string;
  require_app_match: number;
  scope: Scope;
  description: string | null;
}

export interface AuditEntry {
  token_id: number | null;
  method: string;
  path: string;
  app: string | null;
  command: string | null;
  status: number;
  exit_code: number | null;
  remote_addr: string | null;
}

// Versioned migrations; each entry runs once, in order.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NULL,
    last_used_at TEXT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE token_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    app_pattern TEXT NOT NULL,
    scope TEXT NOT NULL,
    UNIQUE (token_id, app_pattern, scope)
  );

  CREATE TABLE cli_allowlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NULL REFERENCES tokens(id) ON DELETE CASCADE,
    command_prefix TEXT NOT NULL,
    allowed_flags_regex TEXT NOT NULL DEFAULT '^.*$',
    require_app_match INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL DEFAULT 'cli',
    description TEXT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    token_id INTEGER NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    app TEXT NULL,
    command TEXT NULL,
    status INTEGER NOT NULL,
    exit_code INTEGER NULL,
    remote_addr TEXT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX idx_perm_token ON token_permissions(token_id);
  CREATE INDEX idx_allowlist_cmd ON cli_allowlist(command_prefix);
  CREATE INDEX idx_audit_created ON audit_log(created_at);
  `,
  `
  ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'token';

  CREATE TABLE github_trusts (
    token_id INTEGER PRIMARY KEY REFERENCES tokens(id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    repository_id TEXT NULL,
    repository_owner_id TEXT NULL,
    environment TEXT NULL,
    ref_pattern TEXT NULL,
    workflow TEXT NULL
  );

  CREATE INDEX idx_trust_repo ON github_trusts(repository);
  `,
];

const TOKEN_COLUMNS = "id, kind, name, token_prefix, created_at, expires_at, last_used_at, revoked";

export const TOKEN_PREFIX = "dk_live_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string = process.env.DOKKU_API_DB || DEFAULT_DB_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        if (v === 0) this.seedAllowlist();
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  private seedAllowlist(): void {
    const insert = this.db.prepare(
      `INSERT INTO cli_allowlist (command_prefix, allowed_flags_regex, require_app_match, scope, description)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const e of DEFAULT_ALLOWLIST) {
      insert.run(e.command, e.flags, e.requireApp ? 1 : 0, e.scope, e.description);
    }
  }

  close(): void {
    this.db.close();
  }

  // --- tokens -------------------------------------------------------------

  createToken(name: string, expiresAt: string | null): { token: string; row: TokenRow } {
    const token = generateToken();
    const info = this.db
      .prepare("INSERT INTO tokens (name, token_prefix, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(name, token.slice(0, 12), hashToken(token), expiresAt);
    return { token, row: this.getTokenById(Number(info.lastInsertRowid))! };
  }

  getTokenById(id: number): TokenRow | undefined {
    return this.db
      .prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE id = ?`)
      .get(id) as TokenRow | undefined;
  }

  getTokenByName(name: string): TokenRow | undefined {
    return this.db
      .prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE name = ?`)
      .get(name) as TokenRow | undefined;
  }

  findTokenBySecret(secret: string): TokenRow | undefined {
    return this.db
      .prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE token_hash = ? AND kind = 'token'`)
      .get(hashToken(secret)) as TokenRow | undefined;
  }

  listTokens(kind?: TokenRow["kind"]): TokenRow[] {
    const stmt = this.db.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens ${kind ? "WHERE kind = ?" : ""} ORDER BY name`);
    return (kind ? stmt.all(kind) : stmt.all()) as unknown as TokenRow[];
  }

  revokeToken(id: number): void {
    this.db.prepare("UPDATE tokens SET revoked = 1 WHERE id = ?").run(id);
  }

  touchToken(id: number): void {
    this.db
      .prepare("UPDATE tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(id);
  }

  // --- GitHub trusts ------------------------------------------------------

  // A trust is a principal like a token, so permissions, allow-list entries,
  // expiry, revocation and the audit log work unchanged. Its token_hash is
  // never a SHA-256 hex digest, so no bearer secret can ever match it.
  createGithubTrust(
    name: string,
    trust: Pick<GithubTrustRow, "repository" | "environment" | "ref_pattern" | "workflow">,
    expiresAt: string | null,
  ): GithubTrust {
    const info = this.db
      .prepare("INSERT INTO tokens (kind, name, token_prefix, token_hash, expires_at) VALUES ('github', ?, 'github', ?, ?)")
      .run(name, `github:${randomBytes(16).toString("hex")}`, expiresAt);
    const id = Number(info.lastInsertRowid);
    this.db
      .prepare("INSERT INTO github_trusts (token_id, repository, environment, ref_pattern, workflow) VALUES (?, ?, ?, ?, ?)")
      .run(id, trust.repository.toLowerCase(), trust.environment, trust.ref_pattern, trust.workflow);
    return this.getGithubTrust(id)!;
  }

  getGithubTrust(tokenId: number): GithubTrust | undefined {
    return this.db
      .prepare(`SELECT ${TOKEN_COLUMNS}, g.* FROM tokens t JOIN github_trusts g ON g.token_id = t.id WHERE t.id = ?`)
      .get(tokenId) as GithubTrust | undefined;
  }

  listGithubTrusts(repository?: string): GithubTrust[] {
    const sql = `SELECT ${TOKEN_COLUMNS}, g.* FROM tokens t JOIN github_trusts g ON g.token_id = t.id
                 ${repository === undefined ? "" : "WHERE g.repository = ?"} ORDER BY t.name`;
    const stmt = this.db.prepare(sql);
    return (repository === undefined ? stmt.all() : stmt.all(repository.toLowerCase())) as unknown as GithubTrust[];
  }

  pinGithubTrust(tokenId: number, repositoryId: string, ownerId: string): void {
    this.db
      .prepare(
        `UPDATE github_trusts SET repository_id = ?, repository_owner_id = ?
         WHERE token_id = ? AND repository_id IS NULL`,
      )
      .run(repositoryId, ownerId, tokenId);
  }

  // --- permissions --------------------------------------------------------

  addPermission(tokenId: number, appPattern: string, scope: Scope): void {
    this.db
      .prepare("INSERT OR IGNORE INTO token_permissions (token_id, app_pattern, scope) VALUES (?, ?, ?)")
      .run(tokenId, appPattern, scope);
  }

  removePermission(tokenId: number, appPattern: string, scope: Scope): number {
    const info = this.db
      .prepare("DELETE FROM token_permissions WHERE token_id = ? AND app_pattern = ? AND scope = ?")
      .run(tokenId, appPattern, scope);
    return Number(info.changes);
  }

  listPermissions(tokenId?: number): (PermissionRow & { token_name: string })[] {
    const sql = `SELECT p.id, p.token_id, p.app_pattern, p.scope, t.name AS token_name
                 FROM token_permissions p JOIN tokens t ON t.id = p.token_id
                 ${tokenId === undefined ? "" : "WHERE p.token_id = ?"}
                 ORDER BY t.name, p.app_pattern, p.scope`;
    const stmt = this.db.prepare(sql);
    return (tokenId === undefined ? stmt.all() : stmt.all(tokenId)) as unknown as (PermissionRow & {
      token_name: string;
    })[];
  }

  // True when the token holds `scope` on an app pattern matching `app`.
  // `app === null` means "not app-bound" and requires the scope on "*".
  hasScope(tokenId: number, scope: Scope, app: string | null): boolean {
    const perms = this.listPermissions(tokenId).filter((p) => p.scope === scope);
    return perms.some((p) => (app === null ? p.app_pattern === "*" : globMatch(p.app_pattern, app)));
  }

  // --- allow-list ---------------------------------------------------------

  addAllowlistEntry(e: Omit<AllowlistRow, "id">): number {
    const info = this.db
      .prepare(
        `INSERT INTO cli_allowlist (token_id, command_prefix, allowed_flags_regex, require_app_match, scope, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.token_id, e.command_prefix, e.allowed_flags_regex, e.require_app_match, e.scope, e.description);
    return Number(info.lastInsertRowid);
  }

  removeAllowlistEntry(id: number): number {
    return Number(this.db.prepare("DELETE FROM cli_allowlist WHERE id = ?").run(id).changes);
  }

  listAllowlist(): (AllowlistRow & { token_name: string | null })[] {
    return this.db
      .prepare(
        `SELECT a.*, t.name AS token_name FROM cli_allowlist a LEFT JOIN tokens t ON t.id = a.token_id
         ORDER BY a.command_prefix, a.id`,
      )
      .all() as unknown as (AllowlistRow & { token_name: string | null })[];
  }

  allowlistFor(tokenId: number): AllowlistRow[] {
    return this.db
      .prepare("SELECT * FROM cli_allowlist WHERE token_id IS NULL OR token_id = ? ORDER BY token_id DESC, id")
      .all(tokenId) as unknown as AllowlistRow[];
  }

  // --- audit & settings ---------------------------------------------------

  audit(e: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (token_id, method, path, app, command, status, exit_code, remote_addr)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.token_id, e.method, e.path, e.app, e.command, e.status, e.exit_code, e.remote_addr);
  }

  listAudit(limit: number): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT a.created_at, t.name AS token, a.method, a.path, a.app, a.command, a.status, a.exit_code, a.remote_addr
         FROM audit_log a LEFT JOIN tokens t ON t.id = a.token_id ORDER BY a.id DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null || value === "") {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    } else {
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    }
  }

  listSettings(): { key: string; value: string }[] {
    return this.db.prepare("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[];
  }
}
